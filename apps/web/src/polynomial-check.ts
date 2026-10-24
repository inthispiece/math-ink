type Rational = { n: bigint; d: bigint };
type Polynomial = Rational[];
const unsupported = () => new Error('仅支持变量 x、有理数、括号、+ - * / 和 0–12 次整数幂；除数必须为非零常数。');
const gcd = (a: bigint, b: bigint): bigint => { a=a<0n?-a:a; b=b<0n?-b:b; while(b) [a,b]=[b,a%b]; return a; };
function rational(n: bigint, d=1n): Rational {
  if (!d || n.toString(2).length>512 || d.toString(2).length>512) throw unsupported();
  if(d<0n) { n=-n; d=-d; }
  const g=gcd(n,d)||1n; return {n:n/g,d:d/g};
}
const zero=()=>rational(0n), one=()=>rational(1n);
const add=(a:Rational,b:Rational)=>rational(a.n*b.d+b.n*a.d,a.d*b.d);
const mul=(a:Rational,b:Rational)=>rational(a.n*b.n,a.d*b.d);
const negate=(a:Rational)=>rational(-a.n,a.d);
function trim(p:Polynomial):Polynomial { while(p.length>1 && !p.at(-1)!.n) p.pop(); return p; }
function plus(a:Polynomial,b:Polynomial):Polynomial { return trim(Array.from({length:Math.max(a.length,b.length)},(_,i)=>add(a[i]||zero(),b[i]||zero()))); }
function times(a:Polynomial,b:Polynomial):Polynomial {
  if(a.length+b.length>26) throw unsupported();
  const out=Array.from({length:a.length+b.length-1},zero);
  for(let i=0;i<a.length;i++) for(let j=0;j<b.length;j++) out[i+j]=add(out[i+j],mul(a[i],b[j]));
  return trim(out);
}
function parse(expression:string):Polynomial {
  if(typeof expression!=='string'||expression.length>1000||!/^[0-9x+\-*/^().\s]+$/.test(expression)) throw unsupported();
  const tokens=expression.match(/\d+(?:\.\d+)?|x|[+\-*/^()]/g)||[];
  if(!tokens.length||tokens.length>200||tokens.join('')!==expression.replace(/\s+/g,'')) throw unsupported();
  let cursor=0, depth=0;
  const atom=():Polynomial=>{
    if(++depth>32) throw unsupported();
    let result:Polynomial;
    const token=tokens[cursor++];
    if(token==='x') result=[zero(),one()];
    else if(token==='(') { result=sum(); if(tokens[cursor++]!==')') throw unsupported(); }
    else if(/^\d+(?:\.\d+)?$/.test(token||'')) {
      const [whole,fraction='']=token.split('.');
      if(whole.length+fraction.length>80) throw unsupported();
      result=[rational(BigInt(whole+fraction),10n**BigInt(fraction.length))];
    } else throw unsupported();
    --depth; return result;
  };
  const power=():Polynomial=>{
    let base=atom();
    if(tokens[cursor]==='^') {
      cursor++; const exponent=tokens[cursor++];
      if(!/^\d+$/.test(exponent||'')||Number(exponent)>12) throw unsupported();
      let result:Polynomial=[one()];
      for(let i=0;i<Number(exponent);i++) result=times(result,base);
      base=result;
    }
    return base;
  };
  const unary=():Polynomial=>{
    if(tokens[cursor]==='+'||tokens[cursor]==='-') {
      const token=tokens[cursor++]; if(++depth>32) throw unsupported();
      const p=unary(); --depth; return token==='-'?p.map(negate):p;
    }
    return power();
  };
  const product=():Polynomial=>{
    let left=unary();
    while(tokens[cursor]==='*'||tokens[cursor]==='/') {
      const operator=tokens[cursor++],right=unary();
      if(operator==='*') left=times(left,right);
      else { if(trim(right).length!==1||!right[0].n) throw unsupported(); left=left.map(c=>mul(c,rational(right[0].d,right[0].n))); }
    }
    return left;
  };
  const sum=():Polynomial=>{
    let left=product();
    while(tokens[cursor]==='+'||tokens[cursor]==='-') { const operator=tokens[cursor++],right=product(); left=plus(left,operator==='-'?right.map(negate):right); }
    return left;
  };
  const result=sum(); if(cursor!==tokens.length) throw unsupported(); return trim(result);
}
function derivative(p:Polynomial):Polynomial { return p.length<2?[zero()]:trim(p.slice(1).map((c,i)=>mul(c,rational(BigInt(i+1))))); }
function value(p:Polynomial,x:bigint):Rational { let out=zero(); for(let i=p.length-1;i>=0;i--) out=add(mul(out,rational(x)),p[i]); return out; }
const display=(r:Rational)=>r.d===1n?r.n.toString():r.n+'/'+r.d;
export interface PolynomialCheck {
  status:'verified'|'disproved'|'unsupported'; tool:'MathInk rational polynomial checker v1';
  scope:string; message:string; counterexample?:{x:string;left:string;right:string};
}
/** Bounded exact algebra; never evaluates JavaScript, runs external tools, or accesses a network. */
export function checkPolynomial(kind:'identity'|'antiderivative',left:string,right:string):PolynomialCheck {
  const base={tool:'MathInk rational polynomial checker v1' as const,scope:'全体实数上的一元有理系数多项式；不验证额外条件或一般定理'};
  try {
    const a=parse(left), b=kind==='antiderivative'?derivative(parse(right.replace(/[+-]\s*C\s*$/,''))):parse(right);
    const difference=plus(a,b.map(negate));
    if(difference.every(c=>c.n===0n)) return {...base,status:'verified',message:kind==='antiderivative'?'候选原函数求导后与被积函数完全一致；仅验证这个多项式关系。':'两式的有理系数逐项相等；仅验证这个多项式恒等式。'};
    for(let x=0n;x<BigInt(difference.length);x++) if(value(difference,x).n!==0n) return {...base,status:'disproved',message:kind==='antiderivative'?'候选原函数求导后不等于被积函数。':'两式不是全体实数上的恒等式。',counterexample:{x:x.toString(),left:display(value(a,x)),right:display(value(b,x))}};
    throw unsupported();
  } catch(error) { return {...base,status:'unsupported',message:error instanceof Error?error.message:'超出工具支持范围，未验证。'}; }
}
