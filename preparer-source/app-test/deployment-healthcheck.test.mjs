import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
const dockerfile = await fs.readFile(new URL('../deployment/Dockerfile', import.meta.url), 'utf8');
const command = dockerfile.split('\n').find(line => line.startsWith('HEALTHCHECK '))?.match(/CMD node -e "(.*)"$/)?.[1];
assert.ok(command);
for (const [name, origin, status, failure, expected] of [
 ['LAN public origin','http://192.168.5.55:8083',200,null,0],
 ['loopback public origin','http://127.0.0.1:8083',200,null,0],
 ['default container origin',undefined,200,null,0],
 ['HTTP rejection','http://192.168.5.55:8083',403,null,1],
 ['HTTP server failure','http://192.168.5.55:8083',503,null,1],
 ['network failure','http://192.168.5.55:8083',0,'network',1],
 ['request timeout','http://192.168.5.55:8083',0,'timeout',1],
]) {
 test('Docker node:http healthcheck: '+name, async () => {
  let captured, timeoutMs, drained=false, destroyed=false;
  const errors=[];
  let finish;
  const done = new Promise(resolve => {finish=resolve;});
  const request = new EventEmitter();
  request.setTimeout=(ms,cb)=>{timeoutMs=ms;if(failure==='timeout')queueMicrotask(cb);return request;};
  request.destroy=error=>{destroyed=true;queueMicrotask(()=>request.emit('error',error));return request;};
  const response = new EventEmitter();
  response.statusCode=status;
  response.resume=()=>{drained=true;queueMicrotask(()=>response.emit('end'));};
  vm.runInNewContext(command,{
   URL,
   process:{env:origin?{PREPARER_PUBLIC_ORIGIN:origin}:{},exit:value=>finish(value)},
   console:{error:value=>errors.push(value)},
   require:name=>{
    assert.equal(name,'node:http','Use node:http; fetch did not preserve Host on the desktop');
    return {get:(url,options,callback)=>{
     captured={url,options};
     if(failure==='network')queueMicrotask(()=>request.emit('error',new Error('network')));
     else if(!failure)queueMicrotask(()=>callback(response));
     return request;
    }};
   },
  });
  const exitCode=await done;
  assert.equal(captured.url,'http://127.0.0.1:8080/health');
  assert.equal(captured.options.headers.Host,new URL(origin||'http://127.0.0.1:8080').host);
  assert.equal(timeoutMs,4000);
  assert.equal(exitCode,expected);
  assert.equal(drained,!failure);
  assert.equal(destroyed,failure==='timeout');
  assert.equal(errors.length,expected);
 });
}
