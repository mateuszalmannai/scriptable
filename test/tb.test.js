// Tests for tb.js in Node (no dependencies): node test/tb.test.js
// tb.js exports its pure functions and commands when Scriptable's globals are absent.
const fs = require('fs'); const assert = require('assert/strict');
const code = fs.readFileSync(require('path').join(__dirname, '..', 'tb.js'), 'utf8');
const AsyncFunction = (async () => {}).constructor;
(async () => {
  const module = { exports: {} };
  await new AsyncFunction('module', code)(module);
  const T = module.exports;
  // time
  assert.equal(T.formatMinutes(450), '7h 30m'); assert.equal(T.formatMinutes(-15), '-0h 15m');
  const now = new Date('2026-11-25T23:30:00Z'); // 00:30 Berlin on the 26th
  assert.equal(T.parseDate('today', now), '2026-11-26');
  assert.equal(T.parseDate('yesterday', now), '2026-11-25');
  assert.throws(() => T.parseDate('2026-02-30', now));
  const sp = T.parseSpan('2026-11-24', '09:00-17:30', now);
  assert.equal(sp.start.toISOString(), '2026-11-24T08:00:00.000Z');
  const su = T.parseSpan('2026-07-01', '0900-1730', now);
  assert.equal(su.start.toISOString(), '2026-07-01T07:00:00.000Z');
  assert.equal(T.parseSpan('2026-03-29', '01:00-04:00', now).end - T.parseSpan('2026-03-29', '01:00-04:00', now).start, 2*3600e3); // DST day
  assert.throws(() => T.parseSpan('today', '17:00-09:00', now)); assert.throws(() => T.parseHHMM('9:60')); assert.throws(() => T.parseHHMM('09:00:00'));
  assert.equal(T.parsePause('1h15m'), 75); assert.equal(T.parsePause('30'), 30); assert.equal(T.parsePause('1.5h'), 90); assert.throws(() => T.parsePause('abc'));
  assert.equal(T.weekday('2026-11-24'), 'Tue 2026-11-24');
  // resolve
  const items = [{id:'1',name:'CustomerPortal'},{id:'2',name:'Internal'},{id:'3',name:'Interview'}];
  assert.equal(T.resolve('p', items, 'cprt').id, '1'); assert.equal(T.resolve('p', items, '2').id, '2');
  assert.throws(() => T.resolve('p', items, 'inte'), /ambiguous/);
  assert.deepEqual(T.pick('p','projects','',items,'2',false), {id:2,name:'Internal'});
  assert.deepEqual(T.pick('p','projects','none',items,'2',false), T.NONE);
  assert.throws(() => T.pick('p','projects','',items,null,true), /mandatory/);
  // errors
  assert.match(new T.ApiError(401,'').message, /^401 unauthorized/);
  assert.equal(new T.ApiError(422,'Urlaubssperre').message, 'Urlaubssperre');
  assert.equal(new T.ApiError(422,'').message, '422 error');
  assert.match(new T.ApiError(429,'').message, /rate limited/);
  assert.equal(T.decodeError(400,'{"error":"bad"}').message, '400 Bad Request: bad');
  // ics
  const cal = T.ics([{id:'7',type:'VAC',startDate:'2026-12-22',endDate:'2027-01-02',days:6,status:'approved'}], {VAC:'Urlaub'}, now);
  assert.match(cal, /DTEND;VALUE=DATE:20270103\r\n/); assert.match(cal, /SUMMARY:Urlaub\r\n/);

  // command flows with a fake transport
  const calls = []; let script = [];
  const transport = async (req) => { calls.push({...req, body: req.body && JSON.parse(req.body)}); const r = script.shift(); assert.ok(r, 'unexpected call ' + req.method + ' ' + req.url); return { headers:{}, ...r, text: r.json === undefined ? '' : JSON.stringify(r.json) }; };
  const mem = {}; const env = (o={}) => ({ client: new T.Client('tb_x', transport, async()=>{}), cache:{load:k=>mem[k],save:(k,v)=>{mem[k]=v}}, now:()=>now, interactive:false, yes:true, ...o });
  const running = { status:'running', startTimestamp: Date.parse('2026-11-25T07:57:00Z'), workTimeElapsedSeconds: 3*3600+600, accumulatedBreakSeconds:0 };
  const projects = { projects:[{id:'10',name:'Internal'},{id:'11',name:'CustomerPortal'}], defaultProjectId:'10', isProjectMandatory:true };
  const cats = { categories:[{id:'5',name:'Development'}], defaultCategoryId:null, isCategoryMandatory:false };
  // stop with break rule -> apply
  script = [{status:200,json:running},{status:200,json:projects},{status:200,json:cats},
    {status:200,json:{outcome:'confirmationRequired',breakRegulation:{detailText:'30m break',resultingWorkMinutes:180,resultingBreakMinutes:30}}},
    {status:200,json:{outcome:'saved',id:'99',workedMinutes:180,breakMinutes:30,breakRegulationApplied:true}}];
  let r = await T.commands.stop(env(), {project:'cprt', message:'release', break:'apply'});
  assert.match(r.text, /Saved entry 99.*correction applied/);
  assert.deepEqual(calls[3].body, {projectId:11,categoryId:0,remarks:'release',breakRegulation:'apply'});
  // stop non-interactive without yes refuses
  script = [{status:200,json:running}]; // lookups cached now
  await assert.rejects(T.commands.stop(env({yes:false}), {}), /Confirmation needed/);
  // 429 retry then 204 discarded
  calls.length = 0;
  script = [{status:200,json:running},{status:429,headers:{'retry-after':'1'}},{status:204}];
  r = await T.commands.stop(env(), {}); assert.equal(r.data.outcome, 'discarded'); assert.equal(calls.length, 3);
  // log batch
  calls.length = 0;
  script = [{status:200,json:{id:'1',workedMinutes:480}},{status:200,json:{id:'2',workedMinutes:405}}];
  r = await T.commands.log(env(), {project:'Internal', pause:'30m', entries:[{date:'2026-11-24',time:'09:00-17:30'},{date:'2026-11-25',time:'08:30-16:00',pause:'45m',remarks:'release day'}]});
  assert.deepEqual(calls[1].body, {startTimestamp:Date.parse('2026-11-25T07:30:00Z'),endTimestamp:Date.parse('2026-11-25T15:00:00Z'),pauseSeconds:2700,projectId:10,categoryId:0,remarks:'release day'});
  // off half-day with sub
  calls.length = 0;
  script = [{status:200,json:[{id:'VAC',name:'Urlaub',halfDaysAllowed:true}]},{status:200,json:[{id:'42',name:'Anna Beispiel'}]},{status:200,json:{id:'5',type:'VAC',days:0.5,status:'pending'}}];
  r = await T.commands.off(env(), {start:'2026-12-05', half:'afternoon', sub:'anna'});
  assert.deepEqual(calls[2].body, {absenceTypeId:'VAC',startDate:'2026-12-05',endDate:'2026-12-05',halfDay:'afternoon',substituteEmployeeId:'42'});
  // absence cancel with 400 hint
  script = [{status:200,json:[{id:'5',type:'VAC',startDate:'2026-12-05',endDate:'2026-12-05',status:'approved'}]},{status:400,json:{error:'reason required'}}];
  await assert.rejects(T.commands['absence-cancel'](env(), {id:'5'}), /may require a reason/);
  assert.equal(calls.at(-1).method, 'DELETE'); assert.ok(calls.at(-1).url.endsWith('/absence-requests/5'));
  // entries query
  script = [{status:200,json:[{id:'2',date:'2026-11-25',startTime:'08:00',endTime:'12:00',workedMinutes:240,breakMinutes:0,status:'approved'},{id:'1',date:'2026-11-24',workedMinutes:60,breakMinutes:0,status:'approved'}]}];
  r = await T.commands.entries(env(), {month:'2026-11'});
  assert.ok(calls.at(-1).url.endsWith('/time-entries/my?year=2026&month=11')); assert.match(r.rows[0].title, /^Tue 2026-11-24/); assert.match(r.summary, /5h 00m in 2/);
  console.log('all tests passed (TZ=' + (process.env.TZ||'local') + ')');
})().catch(e => { console.error(e); process.exit(1); });
