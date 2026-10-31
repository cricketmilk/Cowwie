const { Watcher } = require('./watch');
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, 'app');
// Scratch tree for the watcher to observe — created here so the test runs
// on a fresh checkout, not just the machine it was written on.
fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
fs.writeFileSync(path.join(root, 'index.html'), '<h1>v1</h1>');

let fires = 0;
const w = new Watcher(root, () => { fires++; }, { debounceMs: 80 });
console.log('started:', w.start());

const results = [];
const step = (label, fn, delay) => new Promise(r => setTimeout(async () => {
  const before = fires; await fn();
  setTimeout(() => { results.push([label, fires - before]); r(); }, 200);
}, delay));

(async () => {
  // 1. single edit -> exactly one fire (debounced)
  await step('single edit', () => fs.writeFileSync(path.join(root,'index.html'),'<h1>v2</h1>'), 100);
  // 2. burst of 5 writes -> still one fire
  await step('burst x5', () => { for(let i=0;i<5;i++) fs.writeFileSync(path.join(root,'index.html'),'<h1>b'+i+'</h1>'); }, 100);
  // 3. nested file
  await step('nested edit', () => fs.writeFileSync(path.join(root,'sub','style.css'),'body{}'), 100);
  // 4. editor swap file -> ignored
  await step('editor .swp (ignored)', () => fs.writeFileSync(path.join(root,'.index.html.swp'),'x'), 100);
  // 5. node_modules -> ignored
  await step('node_modules (ignored)', () => { fs.mkdirSync(path.join(root,'node_modules'),{recursive:true}); fs.writeFileSync(path.join(root,'node_modules','x.js'),'y'); }, 100);

  w.stop();
  // 6. no fire after stop
  const afterStopBefore = fires;
  fs.writeFileSync(path.join(root,'index.html'),'<h1>post-stop</h1>');
  await new Promise(r=>setTimeout(r,200));
  results.push(['no fire after stop', fires - afterStopBefore]);

  let bad = 0;
  const expect = { 'single edit':1,'burst x5':1,'nested edit':1,'editor .swp (ignored)':0,'node_modules (ignored)':0,'no fire after stop':0 };
  for (const [label, n] of results) {
    const want = expect[label];
    const ok = n === want;
    if (!ok) bad++;
    console.log(`  ${ok?'ok  ':'FAIL'} ${label.padEnd(24)} fired ${n}, expected ${want}`);
  }
  console.log(bad ? `\n${bad} failed` : '\nall passed');
  process.exit(bad?1:0);
})();
