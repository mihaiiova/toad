/** Single-request HTTP recording. Trusted, non-secret fixtures only. */
import { replayCliPayload } from './toad-cli-recording.mjs';
const keys = (v, names) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === names.slice().sort().join(',');
const text = v => typeof v === 'string' && v.length <= 1024 && !v.includes('\0');
export function validApiPayload(p) {
  if (!keys(p, ['method', 'url', 'headers', 'body', 'expect']) || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(p.method) || !text(p.url) || !text(p.body) || !keys(p.expect, ['status', 'body']) || !Number.isInteger(p.expect.status) || p.expect.status < 100 || p.expect.status > 599) return false;
  try { const u = new URL(p.url); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash) return false; } catch { return false; }
  if (!p.headers || typeof p.headers !== 'object' || Array.isArray(p.headers) || Object.keys(p.headers).length > 10 || Object.entries(p.headers).some(([k,v]) => !['accept', 'content-type'].includes(k) || !text(v) || /[\r\n]/.test(v))) return false;
  return !!((keys(p.expect.body, ['equals']) && text(p.expect.body.equals)) || (keys(p.expect.body, ['contains']) && text(p.expect.body.contains) && p.expect.body.contains.length));
}
// This fixed script runs inside the existing scenario sandbox. Response size,
// redirects and time are bounded; URLs and literals are data, never source.
const SCRIPT = `const p=JSON.parse(process.argv[1]);
try {
const r=await fetch(p.url,{method:p.method,headers:p.headers,...(p.body?{body:p.body}:{}),redirect:'manual',signal:AbortSignal.timeout(30000)});
let body='';const reader=r.body?.getReader();const decoder=new TextDecoder();let size=0;
if(reader)while(true){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>1048576){await reader.cancel();throw Error('response too large')}body+=decoder.decode(x.value,{stream:true})}body+=decoder.decode();
const ok=r.status===p.expect.status&&(Object.hasOwn(p.expect.body,'equals')?body===p.expect.body.equals:body.includes(p.expect.body.contains));
console.log(JSON.stringify({status:r.status,body}));console.log(ok?'API assertion passed':'API assertion failed');process.exitCode=ok?0:1;
}catch{console.log('API execution error');process.exitCode=2}`;
export function apiCliPayload(p) {
  if (!validApiPayload(p)) throw new Error('Invalid API payload');
  return { program: 'node', args: ['--input-type=module', '-e', SCRIPT, JSON.stringify(p)], expect: { exitCode: 0, stdout: { contains: 'API assertion passed\n' } } };
}
export function apiDescription(p) {
  return [{ action: `${p.method} ${p.url}; headers ${JSON.stringify(p.headers)}; body ${JSON.stringify(p.body)}`, assertion: `HTTP ${p.expect.status}; body ${JSON.stringify(p.expect.body)}` }];
}
export function replayApiPayload(p, options) {
  const result = replayCliPayload(apiCliPayload(p), options);
  if ([2, 126, 127].includes(result.actual.exitCode)) throw new Error('HTTP replay infrastructure or prerequisite error');
  return result;
}
