import {readFile, writeFile, readdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const android = join(root, 'upstream/siyuan-android');
const harmony = join(root, 'upstream/siyuan-harmony');
const id = 'io.github.inthispiece.mathink';
const policy = 'MathInk 是免费开源的数学笔记实验版。笔迹与笔记默认保存在本机，可离线书写。只有你选择选区并同意联网识别后，选区图片才会发送到你配置的识别网关及 Mathpix；原始笔迹坐标不上传。联网识别可能收费，限额用尽不影响本地笔记。拒绝识别不会影响书写。本机不包含服务商密钥；网关管理员应按公开部署说明关闭改进模型设置，并仅保存计费和请求状态，不记录图片与公式正文。卸载可能移除本地数据，请先导出备份。软件按 AGPL-3.0-or-later 提供，不保证公式正确，确认前请核对原稿。源码、问题反馈及完整协议：https://github.com/inthispiece/math-ink。此文本用于本地实验，商城发行前须补充实际运营主体、联系地址及最终服务信息。';
async function edit(path, modify) {
  const before = await readFile(path, 'utf8');
  const after = modify(before);
  if (after !== before) await writeFile(path, after);
}
async function loopback(dir, extension) {
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await loopback(path, extension);
    else if (entry.name.endsWith(extension)) await edit(path, text =>
      text.replaceAll('127.0.0.1:6806', '127.0.0.1:6817'));
  }
}

await edit(join(android, 'app/build.gradle'), text => text
  .replace('applicationId "org.b3log.siyuan"', `applicationId "${id}"`)
  .replace('minSdk = 26', 'minSdk = 29')
  .replaceAll('"app_package_name", "org.b3log.siyuan"', `"app_package_name", "${id}"`)
  .replaceAll('"app_package_name", "org.b3log.siyuan.debug"', `"app_package_name", "${id}.debug"`)
  .replaceAll('"app_name", "SiYuan-Debug"', '"app_name", "MathInk-Debug"')
  .replaceAll('"siyuan-${', '"mathink-${'));
await edit(join(android, 'build.gradle'), text => text
  .replace('siyuanVersionCode = 414', 'siyuanVersionCode = 1')
  .replace('siyuanVersionName = "3.8.6"', 'siyuanVersionName = "0.1.0"'));
await edit(join(android, 'flavors.gradle'), text => text
  .replaceAll('"app_name", "SiYuan"', '"app_name", "MathInk"')
  .replaceAll('"app_name", "思源笔记"', '"app_name", "MathInk 数学笔记"'));
await edit(join(android, 'app/src/main/AndroidManifest.xml'), text => text
  .replace('android:scheme="siyuan"', 'android:scheme="mathink"')
  .replace('android:taskAffinity="org.b3log.siyuan.shorthand"', `android:taskAffinity="${id}.shorthand"`)
  .replace('android:scheme="shorthand"', 'android:scheme="mathink-shorthand"'));
await edit(join(android, 'app/src/main/res/xml/shortcuts.xml'), text => text
  .replace('android:data="shorthand"', 'android:data="mathink-shorthand:"')
  .replace('android:targetPackage="org.b3log.siyuan"', 'android:targetPackage="@string/app_package_name"'));
await loopback(join(android, 'app/src/main/java'), '.java');
await edit(join(android, 'app/src/main/java/org/b3log/siyuan/MainActivity.java'), text => text
  .replace('SIYUAN_WEBVIEW_PORT = 6806', 'SIYUAN_WEBVIEW_PORT = 6817'));
for (const layout of ['activity_boot.xml', 'activity_main.xml']) {
  await edit(join(android, 'app/src/main/res/layout', layout), text => text
    .replaceAll('@drawable/icon', '@drawable/mathink_launcher')
    .replaceAll('android:text="思源笔记"', 'android:text="MathInk 数学笔记"')
    .replaceAll('从思考到洞见，与智能体同行', '从手写到可编辑数学公式')
    .replaceAll('#d23f31', '#246C61'));
}
await edit(join(android, 'app/src/main/java/org/b3log/siyuan/KernelService.java'), text => text
  .replace('Keeps the SiYuan kernel running in the background', 'Keeps the MathInk note kernel running in the background')
  .replace('.setContentTitle("SiYuan")', '.setContentTitle("MathInk")'));
await edit(join(android, 'app/src/main/java/org/b3log/siyuan/RedirectUriReceiverActivity.java'), text => text
  .replace('final Uri data = intent.getData();', 'Uri data = intent.getData();')
  .replace(text.includes('// Keep upstream block routing') ? '__mathink_already_applied__' : '        final Intent target;', '        // Keep upstream block routing internally while owning the OS scheme.\n        if ("mathink".equalsIgnoreCase(data.getScheme())) {\n            data = data.buildUpon().scheme("siyuan").build();\n        }\n\n        final Intent target;'));
await edit(join(android, 'app/src/main/java/org/b3log/siyuan/BootActivity.java'), text => {
  const start = text.indexOf('    private final String agreement =');
  if (start < 0) throw new Error('Android agreement anchor missing');
  return text.slice(0, start) + `    private final String agreement = ${JSON.stringify(policy)};\n}\n`;
});

await edit(join(harmony, 'AppScope/app.json5'), text => text
  .replace('"bundleName": "org.b3log.siyuan.ho"', `"bundleName": "${id}.ho"`)
  .replace('"vendor": "云南链滴科技有限公司"', '"vendor": "inthispiece"')
  .replace('"versionCode": 1000097', '"versionCode": 1')
  .replace('"versionName": "3.8.6"', '"versionName": "0.1.0"'));
await edit(join(harmony, 'AppScope/resources/base/element/string.json'), text => text
  .replace('"value": "思源笔记"', '"value": "MathInk 数学笔记"'));
await edit(join(harmony, 'entry/src/main/resources/base/element/string.json'), text => text
  .replace('"value": "思源笔记"', '"value": "MathInk 数学笔记"')
  .replace('"value": "从思考到洞见，与智能体同行"', '"value": "从手写到可编辑数学公式"'));
await edit(join(harmony, 'entry/src/main/resources/base/profile/shortcuts_config.json'), text => text
  .replaceAll('org.b3log.siyuan.ho', `${id}.ho`));
await edit(join(harmony, 'entry/src/main/module.json5'), text => text
  .replace('"scheme": "siyuan"', '"scheme": "mathink"')
  .replaceAll('"startWindowIcon": "$media:startIcon"', '"startWindowIcon": "$media:mathink_foreground"'));
await loopback(join(harmony, 'entry/src/main/ets'), '.ets');
await edit(join(harmony, 'entry/src/main/ets/entryability/EntryAbility.ets'), text => text
  .replace('const uri = want.uri ?? "";', 'const uri = (want.uri ?? "").replace(/^mathink:/i, "siyuan:");'));
await edit(join(harmony, 'entry/src/main/ets/pages/Agreement.ets'), text => text
  .replace('Utils.getContext().getApplicationContext().clearUpApplicationData();',
    'Utils.getContext().terminateSelf();'));
await edit(join(harmony, 'entry/src/main/ets/pages/PrivacyPolicyDialog.ets'), text => {
  if (text.includes(policy)) return text;
  const from = text.indexOf('          Text() {');
  const to = text.indexOf('        }.height(120)', from);
  if (from < 0 || to < 0) throw new Error('Harmony privacy dialog anchor missing');
  return text.slice(0, from) + `          Text(${JSON.stringify(policy)})\n            .fontSize(16).fontColor($r('app.color.body_color')).margin({ left: 25, right: 25 })\n` +
    text.slice(to).replace('}.height(120)', '}.height(260)');
});
// Never ship someone else's signing-material paths. DevEco auto-signing is
// configured locally, independently for this application's bundle identity.
await edit(join(harmony, 'build-profile.json5'), text => text
  .replace(/"signingConfigs":\s*\[[\s\S]*?\],\s*"products":/, '"signingConfigs": [],\n    "products":')
  .replace(/\s*"signingConfig": "default",/, '')
  .replace('"compatibleSdkVersion": "5.0.0(12)"', '"compatibleSdkVersion": "5.1.0(18)"'));
console.log('Applied MathInk identities, private data sandboxes, port 6817, and local first-run policy.');
