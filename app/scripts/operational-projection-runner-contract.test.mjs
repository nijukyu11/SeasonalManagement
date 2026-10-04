import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../../deploy/traffic-report/seasonal-operational-projection-runner',import.meta.url));
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const fresh = {is_fresh:true,source_watermark:10,observed_watermark:10,current_watermark:10};
const stale = {...fresh,is_fresh:false};

// Execute the unmodified shell runner. Only external host adapters are replaced:
// PostgreSQL responses, syslog, and flock's busy result. This does not prove
// real PostgreSQL notification delivery or systemd timer scheduling.
async function run({statuses,refreshFailure=false,busy=false,listen=false}) {
  const dir = await mkdtemp(join(tmpdir(),'operational-runner-'));
  try {
    const statePath=join(dir,'state.json');
    await writeFile(statePath,JSON.stringify({statuses,refreshFailure,statusReads:0,refreshes:0,listen,connections:0}));
    const dbPath=join(dir,'database.cjs');
    await writeFile(dbPath,`const fs=require('node:fs'); const p=process.env.RUNNER_STATE; const s=JSON.parse(fs.readFileSync(p,'utf8')); const q=process.argv.at(-1); let failed=false;
if(s.listen) {
  process.stdin.once('data',()=>{s.connections++;fs.writeFileSync(p,JSON.stringify(s));process.exit(2);});
} else {
if(q.includes('operational_projection_status_v1')) { const value=s.statuses[Math.min(s.statusReads,s.statuses.length-1)]; s.statusReads++; if(value!==null)console.log(JSON.stringify(value)); }
else if(q.includes('refresh_operational_canonical_legs_v1')) {s.refreshes++; failed=s.refreshFailure;}
else throw Error('Unexpected SQL: '+q);
fs.writeFileSync(p,JSON.stringify(s)); if(failed)process.exit(1);
}
`);
    const parserPath=join(dir,'json.cjs');
    await writeFile(parserPath,`const value=JSON.parse(process.argv[4])[process.argv[5]]; if(value!==null&&value!==undefined)console.log(String(value));`);
    const envPath=join(dir,'adapters.sh');
    await writeFile(envPath,`function /usr/bin/docker { "$RUNNER_NODE" "$RUNNER_DATABASE" "$@"; }
function /usr/bin/python3 { "$RUNNER_NODE" "$RUNNER_JSON" "$@"; }
function /usr/bin/logger { return 0; }
function /usr/bin/flock { if [[ "$RUNNER_BUSY" == "true" ]]; then return 1; fi; return 0; }
if [[ "$RUNNER_LISTEN" == "true" ]]; then
  reconnects=0
  function /usr/bin/sleep {
    if [[ "$1" == "5" ]]; then
      reconnects=$((reconnects+1))
      ((reconnects < 2))
    else
      /bin/sleep 0.05
    fi
  }
fi
`);
    const args=listen
      ? ['-c','trap "" PIPE; /usr/bin/timeout --kill-after=1s 5s "$BASH" "$1" listen','runner-test',runner]
      : [runner,'run'];
    const child=spawnSync(bash,args,{encoding:'utf8',timeout:30000,env:{...process.env,
      BASH_ENV:envPath.replaceAll('\\','/'),RUNNER_NODE:process.execPath.replaceAll('\\','/'),
      RUNNER_DATABASE:dbPath.replaceAll('\\','/'),RUNNER_JSON:parserPath.replaceAll('\\','/'),RUNNER_STATE:statePath,
      RUNNER_LISTEN:String(listen),
      RUNNER_BUSY:String(busy),OPERATIONAL_PROJECTION_LOCK_FILE:join(dir,'runner.lock').replaceAll('\\','/'),
      OPERATIONAL_PROJECTION_ALERT_ADAPTER:join(dir,'no-alert'),OPERATIONAL_PROJECTION_MAX_ATTEMPTS:'3',
    }});
    if(child.error)throw child.error;
    return {...JSON.parse(await readFile(statePath,'utf8')),exit:child.status,output:child.stdout+child.stderr};
  } finally {await rm(dir,{recursive:true,force:true});}
}

test('fresh state skips a full refresh',async()=>{
  const r=await run({statuses:[fresh]});
  assert.equal(r.exit,0,r.output); assert.equal(r.refreshes,0); assert.equal(r.statusReads,1);
});
test('stale projection is refreshed and checked again',async()=>{
  const r=await run({statuses:[stale,fresh]});
  assert.equal(r.exit,0,r.output); assert.equal(r.refreshes,1); assert.equal(r.statusReads,2);
});
test('operational revision race retries even when legacy watermarks did not move',async()=>{
  const r=await run({statuses:[stale,stale,stale,fresh]});
  assert.equal(r.exit,0,r.output); assert.equal(r.refreshes,2); assert.equal(r.statusReads,4);
});
test('continuous writes exhaust the bounded retry budget without claiming success',async()=>{
  const r=await run({statuses:[stale]});
  assert.equal(r.exit,1,r.output); assert.equal(r.refreshes,3); assert.equal(r.statusReads,6);
});
test('failed refresh and missing status fail closed',async()=>{
  const failed=await run({statuses:[stale],refreshFailure:true});
  assert.equal(failed.exit,1,failed.output); assert.equal(failed.refreshes,1); assert.equal(failed.statusReads,1);
  const missing=await run({statuses:[null]});
  assert.equal(missing.exit,1,missing.output); assert.equal(missing.refreshes,0);
});
test('busy lock exits without querying or refreshing',async()=>{
  const r=await run({statuses:[stale],busy:true});
  assert.equal(r.exit,0,r.output); assert.equal(r.refreshes,0); assert.equal(r.statusReads,0);
});
test('listener reconnects after the database closes its pipe even when SIGPIPE is ignored',async()=>{
  const r=await run({statuses:[],listen:true});
  assert.equal(r.connections,2,r.output);
  assert.equal(r.exit,1,'the adapter ends the test after the second connection, not the timeout watchdog');
});
