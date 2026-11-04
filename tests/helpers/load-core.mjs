// 从 polarconsole_eda.html 里把 <script id="bsc-core"> 那一段原样抽出来，用 vm 执行。
// 页面本身不需要任何构建步骤，测试跑的就是用户双击打开的同一份代码。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
export const HTML_PATH = path.resolve(here, '..', '..', 'polarconsole_eda.html');

export function loadCore(){
  const html = readFileSync(HTML_PATH, 'utf8');
  const m = html.match(/<script id="bsc-core">([\s\S]*?)<\/script>/);
  if(!m) throw new Error('bsc-core script block not found in ' + HTML_PATH);
  // Node 里没有 window / document：核心块一旦依赖它们，这里就会直接报错。
  // 用 runInThisContext 而不是新上下文，返回的数组和测试代码同一个 realm，deepStrictEqual 才能比。
  return vm.runInThisContext(m[1] + '\n;BSCore', { filename: 'bsc-core.js' });
}
