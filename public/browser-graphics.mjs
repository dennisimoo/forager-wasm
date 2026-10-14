const S_OK = 0;
const E_INVALIDARG = 0x80070057;
const E_NOINTERFACE = 0x80004002;
const DXGI_UNSUPPORTED = 0x887a0004;
const IUNKNOWN = '0000000000000000c000000000000046';

// COM addresses live in the game's actual WASM heap. Vtables route through
// ARET's existing stdcall dispatcher; unsupported methods throw by name.
export class BrowserGraphics {
  constructor(canvas, interfaces, report, shaders = [], directPresentation = false) {
    this.canvas = canvas;
    this.directPresentation = directPresentation;
    this.display = { width: canvas.width, height: canvas.height };
    this.report = report;
    this.shaders = new Map(shaders.map(shader => [shader.bytecodeHex, shader]));
    this.interfaces = new Map(interfaces.map(value => [value.id, value]));
    this.vtables = new Map();
    this.objects = new Map();
    this.instance = undefined;
    this.gl = canvas.getContext('webgl2', { alpha: false, antialias: false,
      depth: true, stencil: true, premultipliedAlpha: false, preserveDrawingBuffer: !directPresentation });
    if (!this.gl) throw new Error('The renderer requires a real WebGL2 context');
    this.writeMasks = { color: [true,true,true,true], depth: true, stencil: 0xffffffff };
    this.scissorEnabled = false;
    this.limits = {
      attributes: this.gl.getParameter(this.gl.MAX_VERTEX_ATTRIBS),
      uniformBuffers: this.gl.getParameter(this.gl.MAX_UNIFORM_BUFFER_BINDINGS),
      textures: this.gl.getParameter(this.gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
      textureSize: this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE),
    };
    this.report('graphics', { renderer: this.gl.getParameter(this.gl.RENDERER),
      version: this.gl.getParameter(this.gl.VERSION), width: canvas.width, height: canvas.height });
  }

  get memory() { return new DataView(this.instance.exports.memory.buffer); }
  word(address) { return this.memory.getUint32(address >>> 0, true); }
  write(address, value) { this.memory.setUint32(address >>> 0, value >>> 0, true); }
  wideString(address, text, capacity) {
    for (let i = 0; i < capacity; i++) this.memory.setUint16(address + 2 * i,
      i < Math.min(text.length, capacity - 1) ? text.charCodeAt(i) : 0, true);
  }
  guid(address) {
    return Array.from(new Uint8Array(this.instance.exports.memory.buffer, address >>> 0, 16),
      value => value.toString(16).padStart(2, '0')).join('');
  }
  alloc(bytes) {
    const pointer = this.instance.exports.malloc(bytes) >>> 0;
    if (!pointer) throw new Error('WASM graphics allocation failed');
    return pointer;
  }
  owner(type, properties = {}) {
    return { type, references: 1, interfaces: new Map(), ...properties };
  }
  pointer(owner, group) {
    if (owner.interfaces.has(group)) return owner.interfaces.get(group);
    const descriptor = this.interfaces.get(group);
    if (!descriptor) throw new Error(`Unknown graphics interface ${group}`);
    if (!this.vtables.has(group)) {
      const vtable = this.alloc(4 * descriptor.methods.length);
      descriptor.methods.forEach((method, index) => {
        const callable = this.instance.exports.aret_browser_method_va((group << 8) | index, method.pop) >>> 0;
        if (!callable) throw new Error(`${descriptor.name}.${method.name}: no callable address`);
        this.write(vtable + 4 * index, callable);
      });
      this.vtables.set(group, vtable);
    }
    const pointer = this.alloc(4);
    this.write(pointer, this.vtables.get(group));
    owner.interfaces.set(group, pointer);
    this.objects.set(pointer, { owner, group });
    return pointer;
  }
  returnInterface(owner, group, output, addReference = true) {
    if (!output) return 0x80004003;
    const pointer = this.pointer(owner, group);
    if (addReference) owner.references++;
    this.write(output, pointer);
    return S_OK;
  }
  release(owner) {
    if (--owner.references < 0) throw new Error('Graphics object reference underflow');
    if (!owner.references) {
      for (const pointer of owner.interfaces.values()) {
        this.objects.delete(pointer);
        this.instance.exports.free(pointer);
      }
      owner.interfaces.clear();
      if (owner.dispose) owner.dispose();
    }
    return owner.references;
  }
  query(owner, currentGroup, iid, output) {
    if (!output) return 0x80004003;
    this.write(output, 0);
    if (iid === IUNKNOWN) {
      return this.returnInterface(owner, owner.primaryGroup, output);
    }
    const supported = owner.groups;
    // The current interface's inherited IID must preserve its vtable prefix.
    const candidates = [currentGroup, ...supported.filter(group => group !== currentGroup)];
    for (const group of candidates) {
      if (this.interfaces.get(group).iids.some(value => value.bytes === iid)) {
        return this.returnInterface(owner, group, output);
      }
    }
    return E_NOINTERFACE;
  }

  immediateContext(device) {
    if (device.context?.references) return { context: device.context, created: false };
    device.references++; // An outstanding context keeps its device alive.
    const context = this.owner('context', { groups: [2], primaryGroup: 2, device,
      renderTargets: [],
      bindings: new Map(),
      dispose: () => {
        for (const target of context.renderTargets) this.release(target);
        for (const resource of context.bindings.values()) if (resource) this.release(resource);
        this.release(device);
      } });
    device.context = context;
    return { context, created: true };
  }

  object(pointer, type) {
    const owner = this.objects.get(pointer)?.owner;
    if (!owner || owner.type !== type) throw new Error(`Invalid ${type} resource`);
    return owner;
  }

  bind(context, key, resource) {
    if (resource && resource.device !== context.device) throw new Error('Graphics resource belongs to another device');
    if (resource) resource.references++;
    const previous = context.bindings.get(key);
    if (previous) this.release(previous);
    context.bindings.set(key, resource);
  }

  translatedShader(address, size, stage) {
    const bytes = new Uint8Array(this.instance.exports.memory.buffer, address, size);
    const key = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    const translated = this.shaders.get(key);
    if (!translated || translated.stage !== stage) throw new Error(`Missing exact DXBC translation for ${stage} shader (${size} bytes)`);
    return translated;
  }

  shader(device, address, size, stage) {
    const translated = this.translatedShader(address, size, stage);
    const gl = this.gl, shader = gl.createShader(stage === 'vert' ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
    if (!shader) throw new Error('WebGL shader allocation failed');
    gl.shaderSource(shader, translated.glsl); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader); gl.deleteShader(shader);
      throw new Error(`Translated shader compile failed: ${log}`);
    }
    device.references++;
    const group = stage === 'vert' ? 11 : 12;
    return this.owner('shader', { groups: [group], primaryGroup: group, device, stage, translated, shader,
      dispose: () => { gl.deleteShader(shader); this.release(device); } });
  }

  inputLayout(device, address, count, code, length) {
    const translated = this.translatedShader(code, length, 'vert'), gl = this.gl;
    if (!address || !count || count > 32) throw new Error('Invalid input-layout elements');
    const formats = new Map([[2,[4,gl.FLOAT,false,16]],[6,[3,gl.FLOAT,false,12]],
      [16,[2,gl.FLOAT,false,8]],[41,[1,gl.FLOAT,false,4]],[28,[4,gl.UNSIGNED_BYTE,true,4]]]);
    const ends = new Map(), elements = [];
    for (let i = 0; i < count; i++) {
      const values = Array.from({length:7}, (_, j) => this.word(address + 28 * i + 4 * j));
      const [namePointer, index, format, slot, alignedOffset, classification, step] = values;
      const characters = [];
      for (let j = 0; j < 256; j++) {
        const value = this.memory.getUint8(namePointer + j);
        if (!value) break;
        characters.push(String.fromCharCode(value));
      }
      if (!characters.length || characters.length === 256) throw new Error('Invalid vertex semantic');
      const semantic = characters.join('').toUpperCase(), info = formats.get(format);
      if (!info || slot > 31 || classification > 1 || (!classification && step) || (classification && !step)) throw new Error(`Unsupported input element: ${values.join(',')}`);
      const offset = alignedOffset === 0xffffffff ? ends.get(slot) ?? 0 : alignedOffset;
      ends.set(slot, offset + info[3]);
      const signature = Object.entries(translated.inputs).find(([, value]) => value.semantic.toUpperCase() === semantic && value.index === index);
      elements.push({ semantic, index, slot, offset, classification, step, info, location: signature ? Number(signature[0]) : undefined });
    }
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('WebGL input-layout allocation failed');
    device.references++;
    return this.owner('input-layout', { groups:[13], primaryGroup:13, device, translated, elements, vao,
      dispose: () => { gl.deleteVertexArray(vao); this.release(device); } });
  }

  buffer(device, description, initial) {
    const [size, usage, bindings, cpu, misc, stride] = description, gl = this.gl;
    if (!size || usage > 2 || (bindings & ~7) || misc || stride ||
        ((bindings & 2) && bindings !== 2) ||
        (usage === 2 ? cpu !== 0x10000 : cpu !== 0) || (usage === 1 && !initial)) {
      throw new Error(`Unsupported buffer description: ${description.join(',')}`);
    }
    const source = initial ? this.word(initial) : 0;
    if (initial && !source) throw new Error('Invalid buffer initial data');
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('WebGL buffer allocation failed');
    // WebGL keeps index buffers distinct from other buffer kinds. Their
    // initial binding must establish the element-buffer kind.
    const target=bindings & 2 ? gl.ELEMENT_ARRAY_BUFFER : gl.COPY_WRITE_BUFFER;
    const previous = gl.getParameter(bindings & 2 ? gl.ELEMENT_ARRAY_BUFFER_BINDING : gl.COPY_WRITE_BUFFER_BINDING);
    gl.bindBuffer(target, buffer);
    gl.bufferData(target, source ? new Uint8Array(this.instance.exports.memory.buffer, source, size) : size,
      usage === 2 ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    gl.bindBuffer(target, previous);
    if (gl.getError() !== gl.NO_ERROR) { gl.deleteBuffer(buffer); throw new Error('WebGL buffer upload failed'); }
    const cpuPointer = cpu ? this.alloc(size) : 0;
    if (cpuPointer && source) new Uint8Array(this.instance.exports.memory.buffer, cpuPointer, size)
      .set(new Uint8Array(this.instance.exports.memory.buffer, source, size));
    device.references++;
    return this.owner('buffer', { groups:[8], primaryGroup:8, device, buffer, description:[...description], cpuPointer,
      mapped:false, dispose: () => { gl.deleteBuffer(buffer); if (cpuPointer) this.instance.exports.free(cpuPointer); this.release(device); } });
  }

  blendState(device, address) {
    const description=new Uint8Array(this.instance.exports.memory.buffer,address,264).slice();
    const words=new DataView(description.buffer), target=[];
    for (let i=0;i<8;i++) target.push(words.getUint32(8+4*i,true));
    if (target[0] && (!target.slice(1,3).every(value=>[1,2,3,4,5,6,7,8,9,10,11,14,15].includes(value)) ||
        !target.slice(4,6).every(value=>[1,2,3,4,5,6,7,8,9,10,11,14,15].includes(value)) ||
        ![1,2,3,4,5].includes(target[3]) || ![1,2,3,4,5].includes(target[6]))) throw new Error('Unsupported blend-state factors');
    device.references++;
    return this.owner('blend-state',{groups:[14],primaryGroup:14,device,description,target,
      alphaToCoverage:!!words.getUint32(0,true),dispose:()=>this.release(device)});
  }

  applyBlend(context, state, factor, mask) {
    if (mask!==0xffffffff) throw new Error('Custom multisample masks are unsupported');
    const gl=this.gl, target=state?.target ?? [0,2,1,1,2,1,1,15];
    const factors=new Map([[1,gl.ZERO],[2,gl.ONE],[3,gl.SRC_COLOR],[4,gl.ONE_MINUS_SRC_COLOR],
      [5,gl.SRC_ALPHA],[6,gl.ONE_MINUS_SRC_ALPHA],[7,gl.DST_ALPHA],[8,gl.ONE_MINUS_DST_ALPHA],
      [9,gl.DST_COLOR],[10,gl.ONE_MINUS_DST_COLOR],[11,gl.SRC_ALPHA_SATURATE]]);
    const blendFactor=(value,alpha)=>value===14 ? (alpha ? gl.CONSTANT_ALPHA : gl.CONSTANT_COLOR) :
      value===15 ? (alpha ? gl.ONE_MINUS_CONSTANT_ALPHA : gl.ONE_MINUS_CONSTANT_COLOR) : factors.get(value);
    const operations=[0,gl.FUNC_ADD,gl.FUNC_SUBTRACT,gl.FUNC_REVERSE_SUBTRACT,gl.MIN,gl.MAX];
    if (target[0]) {
      gl.enable(gl.BLEND); gl.blendFuncSeparate(blendFactor(target[1],false),blendFactor(target[2],false),blendFactor(target[4],true),blendFactor(target[5],true));
      gl.blendEquationSeparate(operations[target[3]],operations[target[6]]);
    } else gl.disable(gl.BLEND);
    if (state?.alphaToCoverage) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE); else gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    this.writeMasks.color=[1,2,4,8].map(bit=>!!(target[7]&bit));
    gl.blendColor(...factor); gl.colorMask(...this.writeMasks.color);
    this.bind(context,'blend-state',state); context.blendFactor=factor; context.sampleMask=mask;
  }

  depthState(device, address) {
    const description=new Uint8Array(this.instance.exports.memory.buffer,address,52).slice();
    const data=new DataView(description.buffer);
    const values=Array.from({length:4},(_,i)=>data.getUint32(4*i,true));
    const front=Array.from({length:4},(_,i)=>data.getUint32(20+4*i,true));
    const back=Array.from({length:4},(_,i)=>data.getUint32(36+4*i,true));
    if (values[1]>1 || (values[0] && (values[2]<1 || values[2]>8)) ||
        (values[3] && ![...front,...back].every(value=>value>=1 && value<=8))) throw new Error('Invalid depth/stencil state');
    device.references++;
    return this.owner('depth-state',{groups:[15],primaryGroup:15,device,description,values,front,back,
      readMask:data.getUint8(16),writeMask:data.getUint8(17),dispose:()=>this.release(device)});
  }

  applyDepth(context, state, reference) {
    const gl=this.gl, values=state?.values ?? [1,1,2,0];
    const comparisons=[0,gl.NEVER,gl.LESS,gl.EQUAL,gl.LEQUAL,gl.GREATER,gl.NOTEQUAL,gl.GEQUAL,gl.ALWAYS];
    const operations=[0,gl.KEEP,gl.ZERO,gl.REPLACE,gl.INCR,gl.DECR,gl.INVERT,gl.INCR_WRAP,gl.DECR_WRAP];
    if (values[0]) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(comparisons[values[2]]); } else gl.disable(gl.DEPTH_TEST);
    this.writeMasks.depth=!!values[1];
    gl.depthMask(this.writeMasks.depth);
    if (values[3]) {
      gl.enable(gl.STENCIL_TEST);
      this.writeMasks.stencil=state.writeMask;
      for (const [face,description] of [[gl.FRONT,state.front],[gl.BACK,state.back]]) {
        gl.stencilMaskSeparate(face,state.writeMask);
        gl.stencilFuncSeparate(face,comparisons[description[3]],reference&255,state.readMask);
        gl.stencilOpSeparate(face,...description.slice(0,3).map(value=>operations[value]));
      }
    } else gl.disable(gl.STENCIL_TEST);
    this.bind(context,'depth-state',state); context.stencilReference=reference;
  }

  rasterizerState(device, address) {
    const description=new Uint8Array(this.instance.exports.memory.buffer,address,40).slice();
    const data=new DataView(description.buffer);
    const words=Array.from({length:10},(_,i)=>data.getUint32(4*i,true));
    if (words[0]!==3 || ![1,2,3].includes(words[1]) || !words[6] || data.getFloat32(16,true) || words[9]) {
      throw new Error(`Unsupported rasterizer description: ${words.join(',')}`);
    }
    device.references++;
    return this.owner('rasterizer-state',{groups:[16],primaryGroup:16,device,description,words,
      bias:data.getInt32(12,true),slope:data.getFloat32(20,true),dispose:()=>this.release(device)});
  }

  applyScissor(context) {
    const rectangle=context.scissor ?? [0,0,0,0];
    this.gl.scissor(rectangle[0],rectangle[1],Math.max(0,rectangle[2]-rectangle[0]),Math.max(0,rectangle[3]-rectangle[1]));
  }

  applyRasterizer(context, state) {
    const gl=this.gl, words=state?.words ?? [3,3,0,0,0,0,1,0,0,0];
    if (words[1]===1) gl.disable(gl.CULL_FACE);
    else { gl.enable(gl.CULL_FACE); gl.cullFace(words[1]===2 ? gl.FRONT : gl.BACK); }
    // Vertex translation reverses Y, preserving D3D's screen-space winding.
    gl.frontFace(words[2] ? gl.CCW : gl.CW);
    if (state?.bias || state?.slope) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(state.slope,state.bias); }
    else { gl.disable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(0,0); }
    this.scissorEnabled=!!words[7];
    if (this.scissorEnabled) gl.enable(gl.SCISSOR_TEST); else gl.disable(gl.SCISSOR_TEST);
    this.bind(context,'rasterizer-state',state); this.applyScissor(context);
  }

  samplerState(device, address) {
    const description=new Uint8Array(this.instance.exports.memory.buffer,address,52).slice(), data=new DataView(description.buffer);
    const filter=data.getUint32(0,true), modes=[4,8,12].map(offset=>data.getUint32(offset,true));
    if ((filter&~0x15) || modes.some(value=>![1,2,3].includes(value)) || data.getFloat32(16,true)) {
      throw new Error(`Unsupported sampler filter/address/bias: ${filter},${modes.join(',')},${data.getFloat32(16,true)}`);
    }
    // Immutable D3D state objects with identical descriptions share identity.
    // Keep only live owners so this lookup does not extend resource lifetimes.
    device.samplers ??= new Map();
    const key=Array.from(description).join(',');
    const existing=device.samplers.get(key);
    if (existing) { existing.references++; return existing; }
    const gl=this.gl, sampler=gl.createSampler();
    if (!sampler) throw new Error('WebGL sampler allocation failed');
    const wraps=[0,gl.REPEAT,gl.MIRRORED_REPEAT,gl.CLAMP_TO_EDGE];
    for (const [index,parameter] of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T,gl.TEXTURE_WRAP_R].entries()) gl.samplerParameteri(sampler,parameter,wraps[modes[index]]);
    const min=filter&16 ? (filter&1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR_MIPMAP_NEAREST) :
      (filter&1 ? gl.NEAREST_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST);
    gl.samplerParameteri(sampler,gl.TEXTURE_MIN_FILTER,min); gl.samplerParameteri(sampler,gl.TEXTURE_MAG_FILTER,filter&4 ? gl.LINEAR : gl.NEAREST);
    gl.samplerParameterf(sampler,gl.TEXTURE_MIN_LOD,data.getFloat32(44,true)); gl.samplerParameterf(sampler,gl.TEXTURE_MAX_LOD,data.getFloat32(48,true));
    // Present checks accumulated GPU errors once per frame. Checking here
    // synchronizes the GPU for each state object the engine recreates.
    device.references++;
    const state=this.owner('sampler-state',{groups:[17],primaryGroup:17,device,description,sampler,
      dispose:()=>{device.samplers.delete(key);gl.deleteSampler(sampler);this.release(device);}});
    device.samplers.set(key,state);
    return state;
  }

  program(context) {
    const vertex=context.bindings.get('shader:vert'), pixel=context.bindings.get('shader:frag'), gl=this.gl;
    if (!vertex || !pixel) throw new Error('Draw requires vertex and pixel shaders');
    const key=`${vertex.translated.sha256}:${pixel.translated.sha256}`, device=context.device;
    device.programs ??= new Map();
    if (device.programs.has(key)) return device.programs.get(key);
    const program=gl.createProgram();
    if (!program) throw new Error('WebGL program allocation failed');
    gl.attachShader(program,vertex.shader); gl.attachShader(program,pixel.shader); gl.linkProgram(program);
    if (!gl.getProgramParameter(program,gl.LINK_STATUS)) {
      const log=gl.getProgramInfoLog(program); gl.deleteProgram(program);
      throw new Error(`Game shader link failed: ${log}`);
    }
    gl.detachShader(program,vertex.shader); gl.detachShader(program,pixel.shader);
    const blocks=[],samplers=[];
    for (const shader of [vertex,pixel]) {
      for (const block of shader.translated.uniformBlocks) {
        const index=gl.getUniformBlockIndex(program,block.name);
        if (index===gl.INVALID_INDEX) continue;
        const binding=blocks.length;
        if (binding>=this.limits.uniformBuffers) throw new Error('Too many shader constant buffers');
        gl.uniformBlockBinding(program,index,binding);
        blocks.push({...block,stage:shader.stage,binding,size:gl.getActiveUniformBlockParameter(program,index,gl.UNIFORM_BLOCK_DATA_SIZE)});
      }
      for (const sampler of shader.translated.samplers) {
        const location=gl.getUniformLocation(program,sampler.name);
        if (location!==null) samplers.push({...sampler,stage:shader.stage,location});
      }
    }
    const result={program,blocks,samplers,vertex:vertex.translated};
    device.programs.set(key,result); return result;
  }

  draw(context, count, first, indexed, baseVertex=0) {
    if (!count) return 0;
    const gl=this.gl, device=context.device, linked=this.program(context), layout=context.bindings.get('input-layout');
    if (!layout) throw new Error('Draw requires an input layout');
    const modes=[undefined,gl.POINTS,gl.LINES,gl.LINE_STRIP,gl.TRIANGLES,gl.TRIANGLE_STRIP];
    if (modes[context.topology]===undefined) throw new Error('Draw requires a primitive topology');
    if (baseVertex<0) throw new Error('Negative indexed base vertices are not implemented');
    if (!context.bindings.has('depth-state')) this.applyDepth(context,null,0);
    if (!context.bindings.has('rasterizer-state')) this.applyRasterizer(context,null);
    if (!context.bindings.has('blend-state')) this.applyBlend(context,null,[1,1,1,1],0xffffffff);
    this.applyViewport(context); this.applyScissor(context);
    gl.useProgram(linked.program); gl.bindVertexArray(layout.vao);
    for (let index=0;index<this.limits.attributes;index++) gl.disableVertexAttribArray(index);
    for (const input of linked.vertex.reflection.inputs ?? []) {
      const location=gl.getAttribLocation(linked.program,input.name);
      if (location<0) continue;
      const signature=linked.vertex.inputs[input.location];
      const element=layout.elements.find(value=>value.semantic===signature.semantic.toUpperCase() && value.index===signature.index);
      if (!element) throw new Error(`Missing vertex element: ${signature.semantic}${signature.index}`);
      const buffer=context.bindings.get(`vertex:${element.slot}`), parameters=context.vertexParameters?.get(element.slot);
      if (!buffer || !parameters?.stride || buffer.mapped) throw new Error('Draw requires an unmapped vertex buffer with nonzero stride');
      const offset=parameters.offset+element.offset+(element.classification ? 0 : baseVertex*parameters.stride);
      gl.bindBuffer(gl.ARRAY_BUFFER,buffer.buffer); gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location,element.info[0],element.info[1],element.info[2],parameters.stride,offset);
      gl.vertexAttribDivisor(location,element.classification ? element.step : 0);
    }
    for (const block of linked.blocks) {
      const buffer=context.bindings.get(`constant:${block.stage}:${block.slot}`);
      if (buffer) {
        if (buffer.mapped || buffer.description[0]<block.size) throw new Error(`Constant buffer ${block.stage}:${block.slot} is too small or mapped`);
        gl.bindBufferBase(gl.UNIFORM_BUFFER,block.binding,buffer.buffer);
      } else {
        // D3D's documented null constant-buffer binding reads zero values.
        device.zeroConstants ??= gl.createBuffer();
        if (!device.zeroConstants) throw new Error('Null constant-buffer allocation failed');
        gl.bindBuffer(gl.UNIFORM_BUFFER,device.zeroConstants);
        if ((device.zeroConstantSize ?? 0)<block.size) {
          gl.bufferData(gl.UNIFORM_BUFFER,block.size,gl.STATIC_DRAW); device.zeroConstantSize=block.size;
        }
        gl.bindBufferBase(gl.UNIFORM_BUFFER,block.binding,device.zeroConstants);
      }
    }
    if (linked.samplers.length>this.limits.textures) throw new Error('Too many game shader textures');
    for (const [unit,sampler] of linked.samplers.entries()) {
      const view=context.bindings.get(`texture:${sampler.stage}:${sampler.textureSlot}`);
      if (view && context.renderTargets.some(target=>target.resource===view.resource)) throw new Error('Texture is simultaneously a draw target and shader input');
      gl.activeTexture(gl.TEXTURE0+unit);
      if (!view) {
        // A null D3D texture samples transparent zero, including its alpha.
        if (!device.zeroTexture) {
          device.zeroTexture=gl.createTexture();
          if (!device.zeroTexture) throw new Error('Null texture allocation failed');
          gl.bindTexture(gl.TEXTURE_2D,device.zeroTexture);
          gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(4));
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAX_LEVEL,0);
        }
      }
      gl.bindTexture(gl.TEXTURE_2D,view?.resource.texture ?? device.zeroTexture);
      let state=context.bindings.get(`sampler:${sampler.stage}:${sampler.samplerSlot}`)?.sampler;
      if (!state) {
        if (!device.defaultSampler) {
          device.defaultSampler=gl.createSampler();
          if (!device.defaultSampler) throw new Error('Default sampler allocation failed');
          gl.samplerParameteri(device.defaultSampler,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
          gl.samplerParameteri(device.defaultSampler,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
          for (const parameter of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T,gl.TEXTURE_WRAP_R]) gl.samplerParameteri(device.defaultSampler,parameter,gl.CLAMP_TO_EDGE);
          gl.samplerParameterf(device.defaultSampler,gl.TEXTURE_MIN_LOD,-3.4028234663852886e38);
          gl.samplerParameterf(device.defaultSampler,gl.TEXTURE_MAX_LOD,3.4028234663852886e38);
        }
        state=device.defaultSampler;
      }
      gl.bindSampler(unit,state); gl.uniform1i(sampler.location,unit);
    }
    if (indexed) {
      const buffer=context.bindings.get('index'), bytes=context.indexFormat===42 ? 4 : 2;
      if (!buffer || buffer.mapped || context.indexOffset+(first+count)*bytes>buffer.description[0]) throw new Error('Invalid indexed draw range');
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,buffer.buffer);
      gl.drawElements(modes[context.topology],count,bytes===4 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,context.indexOffset+first*bytes);
    } else gl.drawArrays(modes[context.topology],first,count);
    context.draws=(context.draws ?? 0)+1;
    if (context.draws===1) this.report('graphics-draw',{vertices:count,indexed});
    return 0;
  }

  shaderResource(device, resource, description) {
    if (resource.device !== device || !(resource.bindings & 8)) throw new Error('Invalid shader-resource texture');
    const view = description ? Array.from({length: 4}, (_, i) => this.word(description + 4 * i)) :
      [resource.description[4], 4, 0, 1];
    if (view[0] !== resource.description[4] || view[1] !== 4 || view[2] || ![1,0xffffffff].includes(view[3])) {
      throw new Error(`Unsupported shader-resource view: ${view.join(',')}`);
    }
    view[3] = 1;
    resource.references++;
    return this.owner('shader-resource', { groups: [10], primaryGroup: 10, device, resource, description: view,
      dispose: () => this.release(resource) });
  }

  texturePixels(address, pitch, width, height, format) {
    if (!address || pitch < width * 4 || ![28,87].includes(format)) throw new Error('Unsupported texture upload');
    const source=new Uint8Array(this.instance.exports.memory.buffer,address,pitch*(height-1)+width*4);
    const pixels=new Uint8Array(width*height*4);
    for (let y=0;y<height;y++) pixels.set(source.subarray(y*pitch,y*pitch+width*4),y*width*4);
    if (format===87) for (let i=0;i<pixels.length;i+=4) [pixels[i],pixels[i+2]]=[pixels[i+2],pixels[i]];
    return pixels;
  }

  applyViewport(context) {
    if (!context.viewport) return;
    const [x, y, width, height, near, far] = context.viewport;
    // GL row zero represents D3D's top row until presentation.
    this.gl.viewport(x, y, width, height);
    this.gl.depthRange(near, far);
  }

  texture(device, description, initial = 0) {
    const [width, height, levels, arraySize, format, samples, quality, usage, bindings, cpu, misc] = description;
    const gl = this.gl;
    if (!width || !height || width > this.limits.textureSize ||
        height > this.limits.textureSize) throw new Error('Invalid texture dimensions');
    if (levels !== 1 || arraySize !== 1 || samples !== 1 || quality || cpu || misc ||
        ![28, 45, 87].includes(format) || ![0, 1].includes(usage)) {
      throw new Error(`Unsupported texture description: ${description.join(',')}`);
    }
    let pixels = null;
    if (initial) {
      if (format === 45) throw new Error('Depth-stencil initial uploads are unsupported');
      const data = this.word(initial), pitch = this.word(initial + 4);
      pixels=this.texturePixels(data,pitch,width,height,format);
    }
    const previous = gl.getParameter(gl.TEXTURE_BINDING_2D);
    const texture = gl.createTexture();
    if (!texture) throw new Error('WebGL texture allocation failed');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, format === 45 ? gl.DEPTH24_STENCIL8 : gl.RGBA8, width, height, 0,
      format === 45 ? gl.DEPTH_STENCIL : gl.RGBA, format === 45 ? gl.UNSIGNED_INT_24_8 : gl.UNSIGNED_BYTE, pixels);
    gl.bindTexture(gl.TEXTURE_2D, previous);
    if (gl.getError() !== gl.NO_ERROR) {
      gl.deleteTexture(texture);
      throw new Error('WebGL texture upload failed');
    }
    device.references++;
    return this.owner('texture', { groups: [7], primaryGroup: 7, device, texture,
      description: [...description], bindings,
      dispose: () => { gl.deleteTexture(texture); this.release(device); } });
  }

  renderTarget(device, resource, description) {
    if (resource.device !== device || !(resource.bindings & 32)) throw new Error('Invalid render target');
    if (description && (this.word(description) !== resource.description[4] ||
        this.word(description + 4) !== 4 || this.word(description + 8))) {
      throw new Error('Unsupported render-target view description');
    }
    const gl = this.gl, previous = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) throw new Error('WebGL framebuffer allocation failed');
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, resource.texture, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
    if (!complete) { gl.deleteFramebuffer(framebuffer); throw new Error('Incomplete render target'); }
    resource.references++;
    return this.owner('render-target', { groups: [9], primaryGroup: 9, device, resource, framebuffer,
      dispose: () => { gl.deleteFramebuffer(framebuffer); this.release(resource); } });
  }

  depthView(device, resource, description) {
    const view = description ? Array.from({length:4},(_,i)=>this.word(description+4*i)) : [45,3,0,0];
    if (resource.device !== device || !(resource.bindings & 64) || resource.description[4] !== 45 ||
        view[0] !== 45 || view[1] !== 3 || view[2] || view[3]) throw new Error('Unsupported depth-stencil view');
    const gl=this.gl, read=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), draw=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    const framebuffer=gl.createFramebuffer();
    if (!framebuffer) throw new Error('Depth framebuffer allocation failed');
    gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.DEPTH_STENCIL_ATTACHMENT,gl.TEXTURE_2D,resource.texture,0);
    gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
    const complete=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,draw);
    if (!complete) { gl.deleteFramebuffer(framebuffer); throw new Error('Incomplete depth framebuffer'); }
    resource.references++;
    return this.owner('depth-view',{groups:[19],primaryGroup:19,device,resource,framebuffer,description:view,
      dispose:()=>{gl.deleteFramebuffer(framebuffer);this.release(resource);}});
  }

  createSwapChain(factory, device, address, output) {
    if (!address || !output) return E_INVALIDARG;
    this.write(output, 0);
    const description = Array.from({length: 15}, (_, i) => this.word(address + 4 * i));
    if (!description[10] || description[8] || (description[14] & ~2) || description[12] > 1 ||
        ![0, 1, 2].includes(description[13])) {
      throw new Error(`Unsupported swap-chain description: ${description.join(',')}`);
    }
    const [width, height] = description;
    const backBuffer = this.texture(device, [width, height, 1, 1, description[4], description[7],
      description[8], 0, 32, 0, 0]);
    factory.references++;
    const chain = this.owner('swap-chain', { groups: [6], primaryGroup: 6, factory, device, backBuffer,
      description, dispose: () => {
        if (chain.presentTarget) this.release(chain.presentTarget);
        this.release(chain.backBuffer); this.release(factory);
      } });
    return this.returnInterface(chain, 6, output, false);
  }

  createDevice(args) {
    const [adapter, driver, software, flags, levels, count, sdk, deviceOutput, levelOutput, contextOutput] = args;
    if (deviceOutput) this.write(deviceOutput, 0);
    if (contextOutput) this.write(contextOutput, 0);
    if (sdk !== 7 || count > 32 || (count && !levels) || software || adapter) return E_INVALIDARG;
    if (driver !== 1) return DXGI_UNSUPPORTED;
    if (flags & 2) return 0x887a002d; // No desktop SDK debug layer in this backend.
    const requested = levels ? Array.from({length: count}, (_, i) => this.word(levels + 4 * i)) : [0x9300];
    // Forager supplies shaders for the 9.3 path. Higher D3D feature levels
    // require capabilities (e.g. geometry shaders) absent from WebGL2.
    if (!requested.includes(0x9300) || this.gl.isContextLost()) return DXGI_UNSUPPORTED;
    if (!deviceOutput && !contextOutput) return 1; // Validation-only S_FALSE.
    const factory = this.owner('factory', { groups: [5], primaryGroup: 5 });
    const adapterOwner = this.owner('adapter', { groups: [4], primaryGroup: 4, factory,
      dispose: () => this.release(factory) });
    factory.adapter = adapterOwner;
    const device = this.owner('device', { groups: [1, 3], primaryGroup: 1, references: deviceOutput ? 1 : 0,
      adapter: adapterOwner, flags, level: 0x9300, exceptionMode: 0,
      dispose: () => {
        if ([...(device.programs?.values() ?? [])].some(linked=>linked.program===this.gl.getParameter(this.gl.CURRENT_PROGRAM))) this.gl.useProgram(null);
        for (const linked of device.programs?.values() ?? []) this.gl.deleteProgram(linked.program);
        if (device.zeroConstants) this.gl.deleteBuffer(device.zeroConstants);
        if (device.zeroTexture) this.gl.deleteTexture(device.zeroTexture);
        if (device.defaultSampler) this.gl.deleteSampler(device.defaultSampler);
        this.release(adapterOwner);
      } });
    if (deviceOutput) this.returnInterface(device, 1, deviceOutput, false);
    if (contextOutput) this.returnInterface(this.immediateContext(device).context, 2, contextOutput, false);
    if (levelOutput) this.write(levelOutput, device.level);
    this.report('graphics-device', { featureLevel: device.level, flags });
    return S_OK;
  }

  call(methodId, esp) {
    if (!this.instance) throw new Error('Graphics instance is not attached');
    if (methodId === 0x10000) {
      return this.createDevice(Array.from({length: 10}, (_, i) => this.word(esp + 4 * i)));
    }
    const group = methodId >>> 8, index = methodId & 255;
    const descriptor = this.interfaces.get(group);
    const method = descriptor?.methods[index];
    if (!method) throw new Error(`Unknown graphics method ${methodId}`);
    const args = Array.from({length: method.pop / 4}, (_, i) => this.word(esp + 4 * i));
    const object = this.objects.get(args[0]);
    if (!object || object.group !== group) throw new Error(`${descriptor.name}.${method.name}: invalid interface`);
    const owner = object.owner;
    if (method.name === 'QueryInterface') return this.query(owner, group, this.guid(args[1]), args[2]);
    if (method.name === 'AddRef') return ++owner.references;
    if (method.name === 'Release') return this.release(owner);
    if (owner.type === 'device') {
      switch (method.name) {
        case 'GetFeatureLevel': return owner.level;
        case 'GetCreationFlags': return owner.flags;
        case 'GetDeviceRemovedReason': return this.gl.isContextLost() ? 0x887a0005 : S_OK;
        case 'GetImmediateContext': {
          const {context, created} = this.immediateContext(owner);
          return this.returnInterface(context, 2, args[1], !created);
        }
        case 'SetExceptionMode': owner.exceptionMode = args[1]; return S_OK;
        case 'GetExceptionMode': return owner.exceptionMode;
        case 'GetAdapter': return this.returnInterface(owner.adapter, 4, args[1]);
        case 'GetParent': return this.query(owner.adapter, 4, this.guid(args[1]), args[2]);
        case 'CheckMultisampleQualityLevels': {
          if (!args[3] || !args[2] || args[2] > 32) return E_INVALIDARG;
          if (![28,45,87].includes(args[1])) throw new Error(`Unsupported multisample format: ${args[1]}`);
          // Report only sample counts implemented by texture creation.
          this.write(args[3], args[2] === 1 ? 1 : 0);
          return S_OK;
        }
        case 'CreateTexture2D': {
          if (!args[1] || !args[3]) return E_INVALIDARG;
          this.write(args[3], 0);
          const resource = this.texture(owner, Array.from({length: 11}, (_, i) => this.word(args[1] + i * 4)), args[2]);
          return this.returnInterface(resource, 7, args[3], false);
        }
        case 'CreateRenderTargetView': {
          if (!args[3]) return E_INVALIDARG;
          this.write(args[3], 0);
          return this.returnInterface(this.renderTarget(owner, this.object(args[1], 'texture'), args[2]), 9, args[3], false);
        }
        case 'CreateShaderResourceView': {
          if (!args[3]) return E_INVALIDARG;
          this.write(args[3], 0);
          return this.returnInterface(this.shaderResource(owner, this.object(args[1], 'texture'), args[2]), 10, args[3], false);
        }
        case 'CreateDepthStencilView': {
          if (!args[3]) return E_INVALIDARG;
          this.write(args[3],0);
          return this.returnInterface(this.depthView(owner,this.object(args[1],'texture'),args[2]),19,args[3],false);
        }
        case 'CreateVertexShader':
        case 'CreatePixelShader': {
          if (!args[1] || !args[2] || !args[4] || args[3]) return E_INVALIDARG;
          this.write(args[4], 0);
          const stage = method.name === 'CreateVertexShader' ? 'vert' : 'frag';
          const shader = this.shader(owner, args[1], args[2], stage);
          return this.returnInterface(shader, shader.primaryGroup, args[4], false);
        }
        case 'CreateInputLayout': {
          if (!args[5]) return E_INVALIDARG;
          this.write(args[5], 0);
          return this.returnInterface(this.inputLayout(owner, args[1], args[2], args[3], args[4]), 13, args[5], false);
        }
        case 'CreateBuffer': {
          if (!args[1] || !args[3]) return E_INVALIDARG;
          this.write(args[3],0);
          const description = Array.from({length:6}, (_, i) => this.word(args[1]+4*i));
          return this.returnInterface(this.buffer(owner,description,args[2]),8,args[3],false);
        }
        case 'CreateBlendState': {
          if (!args[1] || !args[2]) return E_INVALIDARG;
          this.write(args[2],0);
          return this.returnInterface(this.blendState(owner,args[1]),14,args[2],false);
        }
        case 'CreateDepthStencilState': {
          if (!args[1] || !args[2]) return E_INVALIDARG;
          this.write(args[2],0);
          return this.returnInterface(this.depthState(owner,args[1]),15,args[2],false);
        }
        case 'CreateRasterizerState': {
          if (!args[1] || !args[2]) return E_INVALIDARG;
          this.write(args[2],0);
          return this.returnInterface(this.rasterizerState(owner,args[1]),16,args[2],false);
        }
        case 'CreateSamplerState': {
          if (!args[1] || !args[2]) return E_INVALIDARG;
          this.write(args[2],0);
          return this.returnInterface(this.samplerState(owner,args[1]),17,args[2],false);
        }
      }
    }
    if (owner.type === 'context') {
      if (method.name === 'GetDevice') return this.returnInterface(owner.device, 1, args[1]);
      if (method.name === 'GetType' || method.name === 'GetContextFlags') return 0;
      if (method.name === 'Draw') return this.draw(owner,args[1],args[2],false);
      if (method.name === 'DrawIndexed') return this.draw(owner,args[1],args[2],true,args[3]|0);
      if (method.name === 'UpdateSubresource') {
        const resource=this.objects.get(args[1])?.owner, gl=this.gl;
        if (!resource || resource.device!==owner.device || args[2] || !args[4]) throw new Error('Invalid resource update');
        const box=args[3] ? Array.from({length:6},(_,i)=>this.word(args[3]+4*i)) : null;
        if (resource.type==='buffer') {
          if (resource.description[1]!==0 || (box && (box[1] || box[2] || box[4]!==1 || box[5]!==1))) throw new Error('Unsupported buffer update');
          const left=box?.[0] ?? 0, right=box?.[3] ?? resource.description[0];
          if (right<=left || right>resource.description[0]) throw new Error('Invalid buffer update box');
          const previous=gl.getParameter(gl.COPY_WRITE_BUFFER_BINDING);
          gl.bindBuffer(gl.COPY_WRITE_BUFFER,resource.buffer);
          gl.bufferSubData(gl.COPY_WRITE_BUFFER,left,new Uint8Array(this.instance.exports.memory.buffer,args[4],right-left));
          gl.bindBuffer(gl.COPY_WRITE_BUFFER,previous);
          return 0;
        }
        if (resource.type!=='texture' || resource.description[7]!==0) throw new Error('Unsupported resource update');
        const [width,height,,,format]=resource.description;
        const region=box ?? [0,0,0,width,height,1];
        if (region[2] || region[5]!==1 || region[3]>width || region[4]>height || region[3]<=region[0] || region[4]<=region[1]) throw new Error('Invalid texture update box');
        const pixels=this.texturePixels(args[4],args[5],region[3]-region[0],region[4]-region[1],format);
        const previous=gl.getParameter(gl.TEXTURE_BINDING_2D);
        gl.bindTexture(gl.TEXTURE_2D,resource.texture);
        gl.texSubImage2D(gl.TEXTURE_2D,0,region[0],region[1],region[3]-region[0],region[4]-region[1],gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        gl.bindTexture(gl.TEXTURE_2D,previous);
        return 0;
      }
      if (method.name === 'IASetInputLayout') {
        this.bind(owner, 'input-layout', args[1] ? this.object(args[1], 'input-layout') : null);
        return 0;
      }
      if (method.name === 'OMSetBlendState') {
        const state=args[1] ? this.object(args[1],'blend-state') : null;
        const factor=args[2] ? Array.from({length:4},(_,i)=>this.memory.getFloat32(args[2]+4*i,true)) : [1,1,1,1];
        this.applyBlend(owner,state,factor,args[3]); return 0;
      }
      if (method.name === 'OMSetDepthStencilState') {
        this.applyDepth(owner,args[1] ? this.object(args[1],'depth-state') : null,args[2]); return 0;
      }
      if (method.name === 'RSSetState') {
        this.applyRasterizer(owner,args[1] ? this.object(args[1],'rasterizer-state') : null); return 0;
      }
      if (method.name === 'RSSetScissorRects') {
        if (args[1]>1 || (args[1] && !args[2])) throw new Error('Unsupported scissor count');
        owner.scissor=args[1] ? Array.from({length:4},(_,i)=>this.memory.getInt32(args[2]+4*i,true)) : [0,0,0,0];
        this.applyScissor(owner); return 0;
      }
      if (method.name === 'Map') {
        const buffer = this.object(args[1],'buffer');
        if (buffer.device !== owner.device || !buffer.cpuPointer || args[2] || ![4,5].includes(args[3]) || args[4] || !args[5] || buffer.mapped) {
          throw new Error('Unsupported or invalid buffer map');
        }
        buffer.mapped = true;
        this.write(args[5],buffer.cpuPointer); this.write(args[5]+4,buffer.description[0]); this.write(args[5]+8,buffer.description[0]);
        return S_OK;
      }
      if (method.name === 'Unmap') {
        const buffer = this.object(args[1],'buffer'), gl = this.gl;
        if (buffer.device !== owner.device || args[2] || !buffer.mapped) throw new Error('Invalid buffer unmap');
        const previous = gl.getParameter(gl.COPY_WRITE_BUFFER_BINDING);
        gl.bindBuffer(gl.COPY_WRITE_BUFFER,buffer.buffer);
        gl.bufferSubData(gl.COPY_WRITE_BUFFER,0,new Uint8Array(this.instance.exports.memory.buffer,buffer.cpuPointer,buffer.description[0]));
        gl.bindBuffer(gl.COPY_WRITE_BUFFER,previous); buffer.mapped=false;
        return 0;
      }
      if (method.name === 'IASetVertexBuffers') {
        if (args[1]+args[2]>32 || (args[2] && (!args[3] || !args[4] || !args[5]))) throw new Error('Invalid vertex-buffer range');
        owner.vertexParameters ??= new Map();
        for (let i=0;i<args[2];i++) {
          const pointer=this.word(args[3]+4*i), slot=args[1]+i;
          const buffer=pointer ? this.object(pointer,'buffer') : null;
          if (buffer && !(buffer.description[2]&1)) throw new Error('Buffer lacks vertex binding');
          this.bind(owner,`vertex:${slot}`,buffer);
          owner.vertexParameters.set(slot,{stride:this.word(args[4]+4*i),offset:this.word(args[5]+4*i)});
        }
        return 0;
      }
      if (method.name === 'IASetIndexBuffer') {
        const buffer=args[1] ? this.object(args[1],'buffer') : null;
        if (buffer && (!(buffer.description[2]&2) || ![42,57].includes(args[2]))) throw new Error('Invalid index buffer');
        this.bind(owner,'index',buffer); owner.indexFormat=args[2]; owner.indexOffset=args[3];
        return 0;
      }
      if (method.name === 'IASetPrimitiveTopology') {
        if (![0,1,2,3,4,5].includes(args[1])) throw new Error(`Unsupported primitive topology ${args[1]}`);
        owner.topology=args[1]; return 0;
      }
      if (['VSSetConstantBuffers','PSSetConstantBuffers'].includes(method.name)) {
        if (args[1]+args[2]>14 || (args[2] && !args[3])) throw new Error('Invalid constant-buffer range');
        const stage=method.name.startsWith('VS') ? 'vert' : 'frag';
        for (let i=0;i<args[2];i++) {
          const pointer=this.word(args[3]+4*i), buffer=pointer ? this.object(pointer,'buffer') : null;
          if (buffer && !(buffer.description[2]&4)) throw new Error('Buffer lacks constant binding');
          this.bind(owner,`constant:${stage}:${args[1]+i}`,buffer);
        }
        return 0;
      }
      if (['VSSetSamplers','PSSetSamplers'].includes(method.name)) {
        if (args[1]+args[2]>16 || (args[2] && !args[3])) throw new Error('Invalid sampler slot range');
        const stage=method.name.startsWith('VS') ? 'vert' : 'frag';
        for (let i=0;i<args[2];i++) {
          const pointer=this.word(args[3]+4*i);
          this.bind(owner,`sampler:${stage}:${args[1]+i}`,pointer ? this.object(pointer,'sampler-state') : null);
        }
        return 0;
      }
      if (['VSSetShader', 'PSSetShader'].includes(method.name)) {
        if (args[2] || args[3]) throw new Error('Dynamic shader class linkage is unsupported');
        const stage = method.name.startsWith('VS') ? 'vert' : 'frag';
        const shader = args[1] ? this.object(args[1], 'shader') : null;
        if (shader && shader.stage !== stage) throw new Error('Wrong shader stage');
        this.bind(owner, `shader:${stage}`, shader);
        return 0;
      }
      if (['VSSetShaderResources', 'PSSetShaderResources'].includes(method.name)) {
        if (args[1] + args[2] > 128 || (args[2] && !args[3])) throw new Error('Invalid shader-resource slot range');
        const stage = method.name.startsWith('VS') ? 'vert' : 'frag';
        for (let i = 0; i < args[2]; i++) {
          const pointer = this.word(args[3] + 4 * i);
          this.bind(owner, `texture:${stage}:${args[1] + i}`, pointer ? this.object(pointer, 'shader-resource') : null);
        }
        return 0;
      }
      if (method.name === 'Flush') { this.gl.flush(); return 0; }
      if (method.name === 'OMSetRenderTargets') {
        if (args[1] > 8 || (args[1] && !args[2])) throw new Error(`Invalid render-target binding count ${args[1]}`);
        const pointers=Array.from({length:args[1]},(_,i)=>this.word(args[2]+4*i));
        if (pointers.slice(1).some(Boolean)) throw new Error('Multiple active color targets are not implemented');
        const targets = pointers[0] ? [this.object(pointers[0], 'render-target')] : [];
        const depth=args[3] ? this.object(args[3],'depth-view') : null, gl=this.gl;
        if (depth && depth.device !== owner.device) throw new Error('Depth view belongs to another device');
        if (targets.some(target=>target.device !== owner.device)) throw new Error('Render target belongs to another device');
        if (depth && targets[0] && (depth.resource.description[0]!==targets[0].resource.description[0] ||
            depth.resource.description[1]!==targets[0].resource.description[1])) throw new Error('Mismatched render-target dimensions');
        for (const target of targets) target.references++;
        for (const target of owner.renderTargets) {
          gl.bindFramebuffer(gl.FRAMEBUFFER,target.framebuffer);
          gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.DEPTH_STENCIL_ATTACHMENT,gl.TEXTURE_2D,null,0);
        }
        for (const target of owner.renderTargets) this.release(target);
        owner.renderTargets = targets;
        this.bind(owner,'depth-view',depth);
        gl.bindFramebuffer(gl.FRAMEBUFFER, targets[0]?.framebuffer ?? depth?.framebuffer ?? null);
        if (targets[0]) gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.DEPTH_STENCIL_ATTACHMENT,gl.TEXTURE_2D,depth?.resource.texture ?? null,0);
        this.applyViewport(owner);
        this.applyScissor(owner);
        return 0;
      }
      if (method.name === 'ClearDepthStencilView') {
        const view=this.object(args[1],'depth-view'), gl=this.gl;
        if (args[2]&~3) throw new Error('Invalid depth clear flags');
        const depth=this.memory.getFloat32(esp+12,true), stencil=args[4]&255;
        const framebuffer=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), scissor=this.scissorEnabled;
        const mask=this.writeMasks.depth, stencilMask=this.writeMasks.stencil;
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,view.framebuffer); gl.disable(gl.SCISSOR_TEST);
        gl.depthMask(true); gl.stencilMask(255);
        if (args[2]===3) gl.clearBufferfi(gl.DEPTH_STENCIL,0,depth,stencil);
        else if (args[2]&1) gl.clearBufferfv(gl.DEPTH,0,new Float32Array([depth]));
        else if (args[2]&2) gl.clearBufferiv(gl.STENCIL,0,new Int32Array([stencil]));
        gl.depthMask(mask); gl.stencilMask(stencilMask);
        if (scissor) gl.enable(gl.SCISSOR_TEST); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,framebuffer);
        return 0;
      }
      if (method.name === 'RSSetViewports') {
        if (args[1] > 1 || (args[1] && !args[2])) throw new Error('Unsupported viewport count');
        const viewport = args[1] ? Array.from({length: 6}, (_, i) => this.memory.getFloat32(args[2] + 4 * i, true)) : [0,0,0,0,0,1];
        if (!viewport.every(Number.isFinite) || !viewport.slice(0,4).every(Number.isInteger) ||
            viewport[2] < 0 || viewport[3] < 0 || viewport[4] < 0 || viewport[5] > 1 || viewport[4] > viewport[5]) {
          throw new Error(`Unsupported viewport: ${viewport.join(',')}`);
        }
        owner.viewport = viewport;
        this.applyViewport(owner);
        return 0;
      }
      if (method.name === 'ClearRenderTargetView') {
        const target = this.object(args[1], 'render-target'), gl = this.gl;
        const previous = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
        const scissor = this.scissorEnabled, mask = this.writeMasks.color;
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.framebuffer);
        gl.disable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true);
        gl.clearBufferfv(gl.COLOR, 0, new Float32Array(Array.from({length: 4}, (_, i) => this.memory.getFloat32(args[2] + i * 4, true))));
        gl.colorMask(...mask); if (scissor) gl.enable(gl.SCISSOR_TEST);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previous);
        return 0;
      }
    }
    if (owner.type === 'factory' && method.name === 'CreateSwapChain') {
      return this.createSwapChain(owner, this.object(args[1], 'device'), args[2], args[3]);
    }
    if (owner.type === 'factory' && method.name === 'MakeWindowAssociation') {
      if (args[2] & ~7) return E_INVALIDARG;
      // The browser host never installs a DXGI Alt+Enter handler. Forager
      // explicitly requests NO_ALT_ENTER; automatic desktop handling is absent.
      if (!(args[2] & 2)) throw new Error('Automatic DXGI window handling is unsupported');
      owner.windowAssociation = { window: args[1], flags: args[2] };
      return S_OK;
    }
    if (owner.type === 'factory' && method.name === 'GetWindowAssociation') {
      if (!args[1]) return E_INVALIDARG;
      this.write(args[1], owner.windowAssociation?.window ?? 0);
      return S_OK;
    }
    if (owner.type === 'texture') {
      if (method.name === 'GetDevice') return this.returnInterface(owner.device, 1, args[1]);
      if (method.name === 'GetType') { this.write(args[1], 3); return 0; }
      if (method.name === 'GetDesc') { owner.description.forEach((value, i) => this.write(args[1] + 4 * i, value)); return 0; }
    }
    if (owner.type === 'render-target') {
      if (method.name === 'GetDevice') return this.returnInterface(owner.device, 1, args[1]);
      if (method.name === 'GetResource') return this.returnInterface(owner.resource, 7, args[1]);
    }
    if (owner.type === 'shader' && method.name === 'GetDevice') return this.returnInterface(owner.device, 1, args[1]);
    if (owner.type === 'input-layout' && method.name === 'GetDevice') return this.returnInterface(owner.device, 1, args[1]);
    if (owner.type === 'buffer') {
      if (method.name === 'GetDevice') return this.returnInterface(owner.device,1,args[1]);
      if (method.name === 'GetType') { this.write(args[1],1); return 0; }
      if (method.name === 'GetDesc') { owner.description.forEach((value,i)=>this.write(args[1]+4*i,value)); return 0; }
    }
    if (owner.type === 'blend-state') {
      if (method.name === 'GetDevice') return this.returnInterface(owner.device,1,args[1]);
      if (method.name === 'GetDesc') { new Uint8Array(this.instance.exports.memory.buffer,args[1],264).set(owner.description); return 0; }
    }
    if (owner.type === 'depth-state') {
      if (method.name === 'GetDevice') return this.returnInterface(owner.device,1,args[1]);
      if (method.name === 'GetDesc') { new Uint8Array(this.instance.exports.memory.buffer,args[1],52).set(owner.description); return 0; }
    }
    if (owner.type === 'rasterizer-state') {
      if (method.name === 'GetDevice') return this.returnInterface(owner.device,1,args[1]);
      if (method.name === 'GetDesc') { new Uint8Array(this.instance.exports.memory.buffer,args[1],40).set(owner.description); return 0; }
    }
    if (owner.type === 'sampler-state') {
      if (method.name === 'GetDevice') return this.returnInterface(owner.device,1,args[1]);
      if (method.name === 'GetDesc') { new Uint8Array(this.instance.exports.memory.buffer,args[1],52).set(owner.description); return 0; }
    }
    if (owner.type === 'shader-resource') {
      if (method.name === 'GetDevice') return this.returnInterface(owner.device, 1, args[1]);
      if (method.name === 'GetResource') return this.returnInterface(owner.resource, 7, args[1]);
      if (method.name === 'GetDesc') {
        new Uint8Array(this.instance.exports.memory.buffer, args[1], 24).fill(0);
        owner.description.forEach((value, i) => this.write(args[1] + 4 * i, value));
        return 0;
      }
    }
    if (owner.type === 'depth-view') {
      if (method.name === 'GetDevice') return this.returnInterface(owner.device,1,args[1]);
      if (method.name === 'GetResource') return this.returnInterface(owner.resource,7,args[1]);
      if (method.name === 'GetDesc') {
        new Uint8Array(this.instance.exports.memory.buffer,args[1],24).fill(0);
        owner.description.forEach((value,i)=>this.write(args[1]+4*i,value)); return 0;
      }
    }
    if (owner.type === 'swap-chain') {
      if (method.name === 'ResizeBuffers') {
        const [, count, requestedWidth, requestedHeight, requestedFormat, flags] = args;
        if ((flags & ~2) || count > 16) return E_INVALIDARG;
        let width = requestedWidth, height = requestedHeight;
        if (!width || !height) {
          const storage = this.alloc(24);
          try {
            this.write(storage, owner.description[10]);
            this.write(storage + 4, storage + 8);
            if (!this.instance.exports.aret_GetClientRect(storage)) return 0x887a0001;
            width ||= this.word(storage + 16);
            height ||= this.word(storage + 20);
          } finally { this.instance.exports.free(storage); }
        }
        if (!width || !height || width > this.limits.textureSize || height > this.limits.textureSize)
          return E_INVALIDARG;
        // The presentation view is owned by this backend. All application-held
        // references and views must be released before DXGI permits a resize.
        if (owner.backBuffer.references !== 1 + (owner.presentTarget ? 1 : 0)) return 0x887a0001;
        const format = requestedFormat || owner.description[4];
        const next = this.texture(owner.device, [width, height, 1, 1, format,
          owner.description[7], owner.description[8], 0, 32, 0, 0]);
        if (owner.presentTarget) this.release(owner.presentTarget);
        owner.presentTarget = null;
        this.release(owner.backBuffer);
        owner.backBuffer = next;
        owner.description[0] = width; owner.description[1] = height;
        owner.description[4] = format;
        if (count) owner.description[9] = count;
        owner.description[14] = flags;
        this.report('swap-chain-resized', { width, height });
        return S_OK;
      }
      if (method.name === 'Present') {
        if (args[1] > 4 || (args[2] & ~1)) throw new Error('Unsupported presentation flags');
        if (args[2] & 1) return this.gl.isContextLost() ? 0x887a0005 : S_OK;
        owner.presentTarget ??= this.renderTarget(owner.device, owner.backBuffer, 0);
        const gl = this.gl, [width, height] = owner.description;
        if (this.canvas.width !== width || this.canvas.height !== height) {
          this.canvas.width = width; this.canvas.height = height;
        }
        const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
        const scissor = this.scissorEnabled;
        gl.disable(gl.SCISSOR_TEST);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, owner.presentTarget.framebuffer);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
        gl.blitFramebuffer(0, 0, width, height, 0, height, width, 0, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw);
        if (scissor) gl.enable(gl.SCISSOR_TEST);
        gl.flush();
        const error = gl.getError();
        if (error !== gl.NO_ERROR) throw new Error(`WebGL frame failed: 0x${error.toString(16)}`);
        if (this.directPresentation) {
          this.report('frame', { width, height });
        } else {
          const bitmap = this.canvas.transferToImageBitmap();
          this.report('frame', { bitmap }, [bitmap]);
        }
        return S_OK;
      }
      // Browser canvases do not expose a Windows monitor for native vsync.
      // The original engine handles this failure and uses its alternate path.
      if (method.name === 'GetContainingOutput') {
        if (!args[1]) return E_INVALIDARG;
        this.write(args[1], 0);
        return DXGI_UNSUPPORTED;
      }
      if (method.name === 'GetDevice') return this.query(owner.device, 1, this.guid(args[1]), args[2]);
      if (method.name === 'GetParent') return this.query(owner.factory, 5, this.guid(args[1]), args[2]);
      if (method.name === 'GetDesc') { owner.description.forEach((value, i) => this.write(args[1] + 4 * i, value)); return S_OK; }
      if (method.name === 'GetBuffer') {
        if (args[1]) return E_INVALIDARG;
        return this.query(owner.backBuffer, 7, this.guid(args[2]), args[3]);
      }
    }
    if (owner.type === 'adapter' && method.name === 'GetParent') {
      return this.query(owner.factory, 5, this.guid(args[1]), args[2]);
    }
    if (owner.type === 'adapter' && ['GetDesc', 'GetDesc1'].includes(method.name)) {
      if (!args[1]) return E_INVALIDARG;
      const bytes = method.name === 'GetDesc1' ? 296 : 292;
      new Uint8Array(this.instance.exports.memory.buffer, args[1], bytes).fill(0);
      // WebGL does not expose PCI identifiers or a dedicated-memory budget.
      this.wideString(args[1], `Browser ${this.gl.getParameter(this.gl.RENDERER)}`, 128);
      return S_OK;
    }
    if (owner.type === 'adapter' && method.name === 'EnumOutputs') {
      if (!args[2]) return E_INVALIDARG;
      this.write(args[2], 0);
      if (args[1]) return 0x887a0002; // One browser display; enumeration is exhausted.
      const created = !owner.output?.references;
      if (created) {
        owner.references++;
        owner.output = this.owner('output', { groups: [18], primaryGroup: 18, adapter: owner,
          dispose: () => this.release(owner) });
      }
      return this.returnInterface(owner.output, 18, args[2], !created);
    }
    if (owner.type === 'output' && method.name === 'GetParent') {
      return this.query(owner.adapter, 4, this.guid(args[1]), args[2]);
    }
    if (owner.type === 'output' && method.name === 'GetDesc') {
      if (!args[1]) return E_INVALIDARG;
      this.wideString(args[1], '\\\\.\\DISPLAY1', 32);
      [0, 0, this.display.width, this.display.height, 1, 1, 0x10001].forEach((value, i) => this.write(args[1] + 64 + i * 4, value));
      return S_OK;
    }
    throw new Error(`Unimplemented graphics method: ${descriptor.name}.${method.name}`);
  }
}
