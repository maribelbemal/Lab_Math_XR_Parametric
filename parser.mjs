// A small, dependency-free expression parser. Never uses eval or Function.
const FUNCS = Object.freeze({
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp,
  log: Math.log, ln: Math.log, log10: Math.log10,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
  sign: Math.sign, min: Math.min, max: Math.max,
  pow: Math.pow, hypot: Math.hypot
});
const TWO_ARG = new Set(['atan2','pow']);
const ANY_ARG = new Set(['min','max','hypot']);
const CONSTANTS = Object.freeze({ pi: Math.PI, e: Math.E, tau: 2*Math.PI });

function tokenize(src) {
  const re = /\s*((?:\d+\.?\d*|\.\d+)(?:[eE][+\-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|[+\-*/^(),])/gy;
  const toks = []; let pos=0;
  while (pos < src.length) {
    if (/\s/.test(src[pos])) { pos++; continue; }
    re.lastIndex=pos;
    const m=re.exec(src);
    if (!m) throw new Error(`Símbolo no reconocido cerca de «${src.slice(pos,pos+12)}».`);
    toks.push(m[1]); pos=re.lastIndex;
    if (toks.length>260) throw new Error('La expresión es demasiado larga.');
  }
  // Interpret common textbook notation such as 2x, (x+1)(y-1), sin(x)cos(y).
  const expanded=[];
  const isNum=t=>/^(?:\d+\.?\d*|\.\d+)(?:[eE][+\-]?\d+)?$/.test(t);
  const isId=t=>/^[A-Za-z_][A-Za-z_0-9]*$/.test(t);
  for(const t of toks){
    const prev=expanded[expanded.length-1];
    if(prev && (isNum(prev)||isId(prev)||prev===')') && (isNum(t)||isId(t)||t==='(')){
      // Names directly followed by '(' remain function calls if they are known functions.
      const isFunctionCall=isId(prev)&&t==='('&&Object.hasOwn(FUNCS,prev.toLowerCase());
      if(!isFunctionCall)expanded.push('*');
    }
    expanded.push(t);
  }
  expanded.push('EOF');
  return expanded;
}

export function parseSurfaceEquation(input, coordinateVariables=['x','y']) {
  if (typeof input !== 'string') throw new Error('Escribe una ecuación.');
  let src = input.trim().replace(/π/g, 'pi').replace(/[−–]/g, '-').replace(/×/g, '*').replace(/²/g,'^2').replace(/³/g,'^3');
  src = src.replace(/^z\s*=\s*/i, '');
  if (!src || src.length>250) throw new Error('Escribe una expresión de hasta 250 caracteres.');
  const toks=tokenize(src), vars=new Set(); let at=0, depth=0;
  const peek=()=>toks[at];
  const next=()=>toks[at++];
  const eat=(t)=>{if(peek()===t){next();return true;}return false;};
  const expected=(t)=>{if(!eat(t))throw new Error(`Se esperaba «${t}», pero aparece «${peek()}».`);};
  function nest(fn){depth++;if(depth>50)throw new Error('La expresión está anidada demasiado profundamente.');try{return fn();}finally{depth--;}}
  function primary() {
    if(eat('(')){const v=nest(expression);expected(')');return v;}
    const t=next();
    if(t==='EOF')throw new Error('La expresión está incompleta. Comprueba paréntesis y argumentos.');
    if (/^(?:\d+\.?\d*|\.\d+)(?:[eE][+\-]?\d+)?$/.test(t)) return {type:'num',v:Number(t)};
    if (/^[A-Za-z_][A-Za-z_0-9]*$/.test(t)) {
      const lowered=t.toLowerCase();
      if (eat('(')) {
        if(!Object.hasOwn(FUNCS,lowered))throw new Error(`Función desconocida: ${t}.`);
        const args=[];
        if(!eat(')')) {do {args.push(nest(expression));} while(eat(','));expected(')');}
        if ((ANY_ARG.has(lowered) && args.length<1) || (TWO_ARG.has(lowered) && args.length!==2) || (!ANY_ARG.has(lowered)&&!TWO_ARG.has(lowered)&&args.length!==1))
          throw new Error(`Número incorrecto de argumentos para ${t}().`);
        return {type:'call', name:lowered, args};
      }
      if(Object.hasOwn(CONSTANTS,lowered))return {type:'num',v:CONSTANTS[lowered]};
      if(t.length>12)throw new Error('Los parámetros deben tener nombres de hasta 12 caracteres.');
      if(!coordinateVariables.includes(t))vars.add(t);
      return {type:'var', name:t};
    }
    throw new Error(`Se esperaba un número, variable o función (encontrado: «${t}»).`);
  }
  function power(){const a=primary();if(eat('^'))return {type:'op',op:'^',left:a,right:nest(unary)};return a;}
  function unary(){if(eat('+'))return unary();if(eat('-'))return {type:'neg',a:nest(unary)};return power();}
  function product(){let a=unary();while(peek()==='*'||peek()==='/'){const op=next();a={type:'op',op,left:a,right:unary()};}return a;}
  function expression(){let a=product();while(peek()==='+'||peek()==='-'){const op=next();a={type:'op',op,left:a,right:product()};}return a;}
  const tree=expression();
  if(peek()!=='EOF')throw new Error(`No se reconoce «${peek()}». Recuerda usar * para multiplicar.`);
  if(vars.size>4)throw new Error('Esta versión admite hasta cuatro parámetros libres.');
  function compile(n) {
    if(n.type==='num'){const val=n.v;return ()=>val;}
    if(n.type==='var'){const name=n.name;return (scope)=>scope[name];}
    if(n.type==='neg'){const a=compile(n.a);return s=>-a(s);}
    if(n.type==='call'){const args=n.args.map(compile), fn=FUNCS[n.name];return s=>fn(...args.map(f=>f(s)));}
    const a=compile(n.left),b=compile(n.right);
    switch(n.op){case '+':return s=>a(s)+b(s);case '-':return s=>a(s)-b(s);case '*':return s=>a(s)*b(s);case '/':return s=>a(s)/b(s);case '^':return s=>Math.pow(a(s),b(s));}
  }
  return {expression:src, parameters:[...vars], evaluate:compile(tree)};
}
