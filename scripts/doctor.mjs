import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
console.log('MathInk 环境检查（不会安装或修改系统）');
for (const [name, args] of [['git',['--version']], ['pnpm',['--version']], ['flutter',['--version']], ['go',['version']], ['java',['-version']], ['adb',['version']], ['hdc',['-v']]]) {
  const localFlutter = resolve('.tools/flutter/bin', process.platform === 'win32' ? 'flutter.bat' : 'flutter');
  const executable = name === 'flutter' ? process.env.FLUTTER || (existsSync(localFlutter) ? localFlutter : name) : name;
  const result = spawnSync(executable, args, { encoding: 'utf8', shell: process.platform === 'win32' && ['pnpm', 'flutter'].includes(name), windowsHide: true, timeout: 10000 });
  console.log(`${name}: ${result.error || result.status !== 0 ? '未找到或不可用' : (result.stdout || result.stderr).split(/\r?\n/)[0]}`);
}
console.log(`Node: ${process.version}`);
console.log(`OCR配置: ${existsSync('.env') ? '已有 .env（内容不输出）' : '无 .env；演示模式可用'}`);
console.log('鸿蒙真机签名、SDK和 Linux 内核环境需要在 DevEco Studio / 构建文档中单独核对。');
