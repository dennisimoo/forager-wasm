"""Link the focused regression check against a CMake native noop build."""
import pathlib
import shlex
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parents[2]
build = pathlib.Path(sys.argv[1]).resolve()
command = shlex.split((build / 'CMakeFiles/butterscotch.dir/link.txt').read_text())
command = [arg for arg in command if arg != '-DNDEBUG' and not arg.endswith('/src/cli/main.c.o')]
output = command.index('-o')
command[output + 1] = str(build / 'runtime-regression')
command[1:1] = ['-std=c2x', '-UNDEBUG', '-DENABLE_WAD17', '-DENABLE_WAD16', '-DENABLE_WAD14',
                '-I' + str(root / 'runtime/src'), '-I' + str(root / 'runtime/vendor/stb/ds'),
                '-I' + str(root / 'runtime/vendor/box2d/include'),
                str(root / 'verification/runtime-fixes/regression.c')]
subprocess.run(command, cwd=build, check=True)
subprocess.run([str(build / 'runtime-regression')], check=True)
