//! Shared physical XMM state for the transpiler's machine-stack ABI.
//! Unlike GPR arguments, SSE arguments and results are not part of the fixed
//! dispatcher signature. Lower both halves to shared state before SSA so calls,
//! tail calls and indirect dispatch observe the same registers.
use super::types::*;

fn slot(location: &Location) -> Option<u16> {
    match location {
        Location::Reg(RegId(r @ 16..=31)) => Some(r - 16),
        Location::Reg(RegId(r @ 64..=79)) => Some(r - 64 + 16),
        _ => None,
    }
}

fn read(expr: &mut Expr) {
    if let Expr::Read(location) = expr {
        if let Some(index) = slot(location) {
            *expr = Expr::Call {
                target: CallTarget::Named("__aret_sse_get".into()),
                args: vec![Expr::konst(index as i128, 32)],
                ret: Ty::int(64),
            };
        }
        return;
    }
    match expr {
        Expr::Load { addr, .. } | Expr::Unary(_, addr) | Expr::Cast { expr: addr, .. } => read(addr),
        Expr::Binary(_, a, b) => { read(a); read(b); }
        Expr::Call { target, args, .. } => {
            if let CallTarget::Indirect(address) = target { read(address); }
            for arg in args { read(arg); }
        }
        Expr::Select { cond, then_, else_ } => { read(cond); read(then_); read(else_); }
        _ => {}
    }
}

pub(super) fn lower(blocks: &mut [Block]) {
    for block in blocks {
        for statement in &mut block.stmts {
            match statement {
                Stmt::Set { expr, .. } | Stmt::Assign { expr, .. } | Stmt::CallStmt(expr) => read(expr),
                Stmt::Store { addr, value, .. } => { read(addr); read(value); }
                Stmt::Branch { cond, .. } => read(cond),
                Stmt::Switch { value, .. } => read(value),
                Stmt::Return(Some(expr)) => read(expr),
                _ => {}
            }
            if let Stmt::Set { dst, expr } = statement {
                if let Some(index) = slot(dst) {
                    *statement = Stmt::CallStmt(Expr::Call {
                        target: CallTarget::Named("__aret_sse_set".into()),
                        args: vec![Expr::konst(index as i128, 32), expr.clone()],
                        ret: Ty::int(64),
                    });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeSet, io::Write, process::{Command, Stdio}};

    // Execute optimized emitted C, checking incoming SSE parameters, callee
    // writes and caller reads across an actual translated function boundary.
    #[test]
    fn sse_registers_cross_calls_after_ssa_and_optimization() {
        crate::emit::set_shared_stack(true);
        let lo = Location::Reg(RegId(16));
        let hi = Location::Reg(RegId(64));
        let mut callee = IrFunction { entry: 0x2000, name: "callee".into(), bits: 32,
            blocks: vec![Block { id: 0, addr: 0x2000, stmts: vec![
                Stmt::Set { dst: lo.clone(), expr: Expr::Binary(BinOp::Add,
                    Box::new(Expr::Read(lo.clone())), Box::new(Expr::konst(5, 64))) },
                Stmt::Set { dst: hi.clone(), expr: Expr::Binary(BinOp::Xor,
                    Box::new(Expr::Read(hi.clone())), Box::new(Expr::konst(0x55, 64))) },
                Stmt::Return(Some(Expr::Read(lo.clone()))),
            ], ..Block::default() }], ..IrFunction::default() };
        let mut caller = IrFunction { entry: 0x1000, name: "caller".into(), bits: 32,
            blocks: vec![Block { id: 0, addr: 0x1000, stmts: vec![
                Stmt::Set { dst: lo.clone(), expr: Expr::konst(19, 64) },
                Stmt::Set { dst: hi, expr: Expr::konst(0x123456789abcdef0, 64) },
                Stmt::CallStmt(Expr::Call { target: CallTarget::Direct(0x2000),
                    args: vec![Expr::konst(0, 64); 8], ret: Ty::int(64) }),
                Stmt::Return(Some(Expr::Read(lo))),
            ], ..Block::default() }], ..IrFunction::default() };
        let mut forward = BTreeSet::new();
        let mut body = String::new();
        for function in [&mut callee, &mut caller] {
            lower(&mut function.blocks);
            crate::ssa::to_ssa(function);
            crate::opt::optimize(function);
            body.push_str(&crate::emit::emit_function(function, &mut forward, true));
        }
        let source = format!("#include <stdint.h>\n#include <math.h>\n{}\nuint64_t __aret_sse_regs[32];\n{}\nint main(void){{return sub_1000(0,0,0,0,0,0,0,0)!=24 || __aret_sse_regs[16]!=(UINT64_C(0x123456789abcdef0)^0x55);}}\n",
            crate::emit::float_preamble(&body), body);
        let executable = std::env::temp_dir().join(format!("aret-sse-call-{}", std::process::id()));
        let mut compiler = Command::new("cc").args(["-x", "c", "-O2", "-", "-lm", "-o"])
            .arg(&executable).stdin(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        compiler.stdin.take().unwrap().write_all(source.as_bytes()).unwrap();
        let output = compiler.wait_with_output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let status = Command::new(&executable).status().unwrap();
        let _ = std::fs::remove_file(&executable);
        crate::emit::set_shared_stack(false);
        assert!(status.success(), "SSE register values did not cross the call");
    }
}
