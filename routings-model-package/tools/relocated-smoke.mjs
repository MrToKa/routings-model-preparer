// Temporary localhost-only acceptance harness. It serves an extracted package
// and a separately copied trusted SDK; it has no WFC/APS integration or secrets.
import http from 'node:http';
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { assertLocalNoLinks, validateArchivePath } from '../lib/paths.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(item => { const at = item.indexOf('='); if (!item.startsWith('--') || at < 0) throw new Error('Use --root=DIR --sdk-dir=DIR --evidence=FILE [--port=0].'); return [item.slice(2, at), item.slice(at + 1)]; }));
for (const key of Object.keys(args)) if (!['root', 'sdk-dir', 'evidence', 'port'].includes(key)) throw new Error('Unknown smoke option.');
const root = await assertLocalNoLinks(args.root, { directory: true });
const sdk = await assertLocalNoLinks(args['sdk-dir'], { directory: true });
const evidenceFile = path.resolve(args.evidence);
await assertLocalNoLinks(path.dirname(evidenceFile), { directory: true });
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
const evidence = { reportSchemaVersion: 1, operation: 'relocated-model-browser-smoke', status: 'NOT_RUN',
  startedAt: new Date().toISOString(), serverPid: process.pid, modelRoot: root, sdkRoot: sdk, sdkVersion: '7.130.0',
  packageId: manifest.packageId, contentFingerprint: manifest.contentFingerprint,
  requests: [], cspReports: [], browser: null,
  runtimeFontPolicy: { mode: 'temporary CSS response overlay', source: 'copied SDK style.min.css', target: '/sdk/res/fonts/arimo-v29-latin_latin-ext-regular.woff', originalSdkFilesModified: false, replacements: 0 },
  limitations: ['Local relocation only; no WFC session/iframe or second physical computer acceptance.', 'SDK ArtifaktElement CDN font URLs are remapped in the temporary CSS HTTP response to an already copied local SDK font; model and original SDK bytes are unchanged.'] };
const save = async () => fs.writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
const page = `<!doctype html><html lang="bg"><meta charset="utf-8"><title>Aalborg — пренесен модел, етап 1</title>
<link rel="stylesheet" href="/sdk/style.min.css"><style>html,body{margin:0;height:100%;font-family:Arial,sans-serif;background:#f4f6f8;color:#162536}header{height:110px;box-sizing:border-box;padding:12px 20px;overflow:auto}h1{font-size:18px;margin:0 0 8px}#state{font-weight:bold}#details{white-space:pre-wrap;font-size:12px}#viewer{position:absolute;left:0;right:0;top:110px;bottom:0}</style>
<header><h1>Aalborg — пренесени пакетни ресурси</h1><div id="state" role="status">Зареждане на локалния SDK…</div><div id="details"></div></header><div id="viewer"></div>
<script src="/smoke.js"></script></html>`;
const script = `const status=document.getElementById('state'),details=document.getElementById('details');
const result={startedAt:new Date().toISOString(),userAgent:navigator.userAgent,status:'NOT_RUN',geometryLoaded:false,propertiesLoaded:false,externalAttempts:[],errors:[],cspViolations:[],resourceOrigins:[]};
const nativeFetch=window.fetch.bind(window),nativeOpen=XMLHttpRequest.prototype.open;
function inspect(url){const u=new URL(url,location.href);if(u.origin!==location.origin&&!['blob:','data:'].includes(u.protocol)){result.externalAttempts.push(u.href);throw new Error('External resource blocked: '+u.origin);}}
window.fetch=function(url,options){inspect(typeof url==='string'?url:url.url);return nativeFetch(url,options);};
XMLHttpRequest.prototype.open=function(method,url,...rest){inspect(url);return nativeOpen.call(this,method,url,...rest);};
document.addEventListener('securitypolicyviolation',e=>result.cspViolations.push({directive:e.violatedDirective,blockedURI:e.blockedURI}));
window.addEventListener('error',e=>error(String(e.message)));
async function record(){result.finishedAt=new Date().toISOString();result.resourceOrigins=[...new Set(performance.getEntriesByType('resource').filter(e=>/^https?:/.test(e.name)).map(e=>new URL(e.name).origin))];details.textContent=JSON.stringify(result,null,2);await nativeFetch('/__evidence',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});}
function error(message){result.status='FAIL';result.errors.push(String(message));status.textContent='FAIL — '+message;record();}
const sdkScript=document.createElement('script');sdkScript.src='/sdk/viewer3D.min.js';sdkScript.onerror=()=>error('Липсва локалният SDK');
sdkScript.onload=()=>{try{const V=Autodesk.Viewing;V.Initializer({env:'Local',offline:'true',useADP:false,disableAnalytics:true,shouldInitializeAuth:false,useCookie:false,language:'en',lmvResourceRoot:'/sdk/'},()=>{
const viewer=new V.GuiViewer3D(document.getElementById('viewer'));const started=viewer.start();if(started!==0){error('WebGL start code '+started);return;}viewer.setTheme('light-theme');status.textContent='Зареждане на пренесената геометрия…';
viewer.addEventListener(V.ERROR_EVENT,e=>error('SDK model/resource error '+(e.code||'')));
viewer.addEventListener(V.GEOMETRY_LOADED_EVENT,()=>{result.geometryLoaded=true;result.fragments=viewer.model.getFragmentList().getCount();viewer.setLightPreset(7);viewer.setQualityLevel(false,true);viewer.impl.setTonemapMethod(1);viewer.impl.setTonemapExposureBias(1);viewer.fitToView();viewer.resize();status.textContent='Геометрията е заредена. Проверка на свойствата…';
viewer.model.getObjectTree(tree=>{let leaf,objectCount=0;tree.enumNodeChildren(tree.getRootId(),id=>{objectCount++;if(leaf===undefined&&tree.getChildCount(id)===0&&tree.getNodeName(id))leaf=id;},true);result.objectCount=objectCount;if(leaf===undefined){error('Няма обект за property smoke');return;}
viewer.getProperties(leaf,properties=>{result.propertiesLoaded=true;result.propertyDbId=leaf;result.objectName=properties.name;result.propertyCount=properties.properties?.length||0;result.propertySample=(properties.properties||[]).slice(0,5).map(p=>({name:p.displayName,value:p.displayValue}));
result.status=result.fragments>0&&result.propertyCount>0&&result.externalAttempts.length===0&&result.cspViolations.length===0?'PASS':'FAIL';status.textContent=result.status+' — геометрия и свойства от новото местоположение';record();},code=>error('Property query '+code));},code=>error('Object tree '+code));});
viewer.loadModel(new URL('/resources/output/0/0.svf',location.href).href,{},()=>{},(code,message)=>error('Model load '+code+' '+message));window.addEventListener('resize',()=>viewer.resize());window.addEventListener('pagehide',()=>viewer.finish());
});}catch(e){error(e.message)}};document.head.append(sdkScript);`;

const CSP = "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self' blob:; img-src 'self' data: blob:; font-src 'self' data:; frame-ancestors 'none'; report-uri /csp-report";
const server = http.createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Security-Policy', CSP); response.setHeader('X-Content-Type-Options', 'nosniff');
  const normalized = request.url.replace(/^\/{2,}/, '/');
  const url = new URL(normalized, 'http://127.0.0.1');
  if (!/^127\.0\.0\.1:\d+$/.test(request.headers.host ?? '')) { response.writeHead(403).end(); return; }
  if (request.method === 'POST' && ['/__evidence', '/csp-report'].includes(url.pathname)) {
    const chunks = []; let bytes = 0;
    try { for await (const chunk of request) { bytes += chunk.length; if (bytes > 128 * 1024) throw new Error('Evidence too large.'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (url.pathname === '/csp-report') evidence.cspReports.push(body);
      else { evidence.browser = body; evidence.status = body.status === 'PASS' && evidence.cspReports.length === 0 ? 'PASS' : 'FAIL'; evidence.finishedAt = new Date().toISOString(); }
      await save(); response.writeHead(204).end();
    } catch (error) { response.writeHead(400).end(error.message); }
    return;
  }
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
  const log = { time: new Date().toISOString(), method: request.method, path: url.pathname, status: 0 }; evidence.requests.push(log);
  try {
    if (url.pathname === '/' || url.pathname === '/smoke.js') {
      const body = url.pathname === '/' ? page : script;
      response.setHeader('Content-Type', url.pathname === '/' ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8'); log.status = 200; response.writeHead(200).end(request.method === 'HEAD' ? undefined : body); return;
    }
    let base, relative;
    if (url.pathname.startsWith('/resources/')) { base = root; relative = url.pathname.slice(1); }
    else if (url.pathname.startsWith('/sdk/')) { base = sdk; relative = url.pathname.slice('/sdk/'.length); }
    else { log.status = 404; response.writeHead(404).end(); return; }
    validateArchivePath(relative);
    const file = await assertLocalNoLinks(path.join(base, ...relative.split('/')));
    if (base === sdk && relative === 'style.min.css') {
      const originalCss = await fs.readFile(file, 'utf8');
      let replacements = 0;
      const localCss = originalCss.replace(/https:\/\/fonts\.autodesk\.com\/[^)"'\s]+/g, () => { replacements++; return evidence.runtimeFontPolicy.target; });
      evidence.runtimeFontPolicy.replacements = replacements;
      evidence.runtimeFontPolicy.originalCssSha256 = createHash('sha256').update(originalCss).digest('hex');
      evidence.runtimeFontPolicy.servedCssSha256 = createHash('sha256').update(localCss).digest('hex');
      const body = Buffer.from(localCss, 'utf8'); response.setHeader('Content-Type', 'text/css'); response.setHeader('Content-Length', body.length); log.status = 200; response.writeHead(200).end(request.method === 'HEAD' ? undefined : body); return;
    }
    const stat = await fs.stat(file);
    let start = 0, end = stat.size - 1;
    if (request.headers.range) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
      if (!range || Number(range[1]) >= stat.size || (range[2] && Number(range[2]) < Number(range[1]))) { log.status = 416; response.setHeader('Content-Range', 'bytes */' + stat.size); response.writeHead(416).end(); return; }
      start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), end) : end; response.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + stat.size);
    }
    const type = relative.endsWith('.js') ? 'application/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.json') ? 'application/json' : relative.endsWith('.png') ? 'image/png' : relative.endsWith('.svg') ? 'image/svg+xml' : relative.endsWith('.woff') ? 'font/woff' : 'application/octet-stream';
    response.setHeader('Content-Type', type); response.setHeader('Content-Length', end - start + 1); response.setHeader('Accept-Ranges', 'bytes');
    log.status = request.headers.range ? 206 : 200; response.writeHead(log.status);
    if (request.method === 'HEAD') response.end(); else await pipeline(createReadStream(file, { start, end }), response);
  } catch (error) { log.status ||= 404; if (!response.headersSent) response.writeHead(log.status).end(error.code ?? error.message); else response.destroy(); }
});
await new Promise(resolve => server.listen(Number(args.port ?? 0), '127.0.0.1', resolve));
evidence.url = `http://127.0.0.1:${server.address().port}/`; await save(); console.log(evidence.url);
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, async () => { await save(); server.close(() => process.exit(0)); server.closeAllConnections(); });
process.stdin.setEncoding('utf8');
process.stdin.on('data', async input => { if (input.trim() === 'stop') { await save(); server.close(() => process.exit(0)); server.closeAllConnections(); } });
