import { requestJson } from './recognition-request';
interface Options {
    parent: HTMLElement;
    gateway: () => string;
    fallbackToken: () => string;
    changed: () => void;
    backup: () => void;
    restore: () => void;
    notify: (text: string) => void;
}
/** Sessions belong to the current browser tab and gateway, never to backup files. */
export class HostedAccess {
    private options: Options;
    private panel: HTMLElement;
    private hosted = false;
    constructor(options: Options) {
        this.options = options;
        this.panel = document.createElement('section');
        this.panel.className = 'hosted-access';
        this.panel.innerHTML = '<h3>托管账号与入口迁移</h3><p id="hosted-state">本机配对模式</p><div id="hosted-login" hidden><label class="field">用户名<input id="account-username" autocomplete="username" maxlength="80"/></label><label class="field">密码<input id="account-password" type="password" autocomplete="current-password" maxlength="200"/></label><label class="field">邀请注册码（注册时填写）<input id="account-invite" type="password" autocomplete="off"/></label><div class="dialog-actions"><button id="account-login" type="button" class="button secondary">登录 MathInk</button><button id="account-register" type="button" class="button secondary">使用邀请注册</button><button id="account-logout" type="button" class="link-button" hidden>退出并撤销本次会话</button></div></div><button id="migration-open" type="button" class="link-button">更换入口时迁移笔记</button>';
        options.parent.append(this.panel);
        this.el('account-login').onclick = () => void this.login(false);
        this.el('account-register').onclick = () => void this.login(true);
        this.el('account-logout').onclick = () => void this.logout();
        const dialog = document.createElement('dialog');
        dialog.id = 'migration-dialog';
        dialog.innerHTML = '<h2>将笔记带到另一个入口</h2><p>localhost、局域网 IP 和 HTTPS 域名各自保存笔记，登录不会自动同步或搬移。</p><ol><li>在旧入口导出完整 JSON 备份，核对包含笔迹、公式和来源。</li><li>打开新入口，登录后导入备份；原入口内容继续保留。</li><li>核对笔记数量、原稿、公式和来源跳转，再继续编辑。</li></ol><p>同一笔记 ID 已有不同内容时会停止导入保护现有数据；请先分别备份并核对，不自动覆盖。</p><div class="dialog-actions"><button id="migration-backup" class="button secondary">在当前入口导出完整备份</button><button id="migration-import" class="button secondary">在当前入口导入备份</button><button id="migration-close" class="link-button">关闭</button></div>';
        document.body.append(dialog);
        this.el('migration-open').onclick = () => dialog.showModal();
        this.el('migration-close').onclick = () => dialog.close();
        this.el('migration-backup').onclick = () => options.backup();
        this.el('migration-import').onclick = () => { dialog.close(); (document.getElementById('settings-dialog') as HTMLDialogElement).close(); options.restore(); };
    }
    private el<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
    private key() { return `mathink-session:${this.options.gateway().replace(/\/$/, '')}`; }
    token() { try {
        return sessionStorage.getItem(this.key()) || (this.hosted ? '' : this.options.fallbackToken());
    }
    catch {
        return this.hosted ? '' : this.options.fallbackToken();
    } }
    isHosted(){return this.hosted;}
    async update(mode?: string) {
        this.hosted = mode === 'hosted';
        const localOption=document.querySelector<HTMLOptionElement>('#ocr-provider option[value="ollama"]');
        if(localOption){localOption.disabled=this.hosted;localOption.textContent=this.hosted?'本地 Qwen（请打开电脑本机或局域网入口）':'本地 Qwen（Ollama，实验）';}
        this.el('hosted-login').hidden = !this.hosted;
        const pairing = document.getElementById('pairing-token')?.closest('label');
        if (pairing instanceof HTMLElement)
            pairing.hidden = this.hosted;
        const local = document.getElementById('pair-local');
        if (local instanceof HTMLElement && this.hosted)
            local.hidden = true;
        if (!this.hosted) {
            this.el('hosted-state').textContent = '本机配对模式；笔记保存在当前浏览器。';
            return;
        }
        this.el('hosted-state').textContent = '托管模式：请登录 MathInk，服务端密钥不会下发网页。';
        const token = this.token();
        if (!token)
            return;
        try {
            const { response, data } = await requestJson<{
                user?: {
                    username?: string;
                };
            }>(`${this.options.gateway().replace(/\/$/, '')}/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } }, { timeoutMs: 5000 });
            if (response.ok && data?.user) {
                this.el('hosted-state').textContent = `已登录 ${data.user.username || 'MathInk 用户'}；用量按账号计算。笔记仍只保存在当前入口。`;
                this.el('account-logout').hidden = false;
            }
            else {
                sessionStorage.removeItem(this.key());
                this.el('account-logout').hidden = true;
            }
        }
        catch { /* Offline writing remains available. */ }
    }
    private async login(register: boolean) { const gateway = this.options.gateway(); const username = this.el<HTMLInputElement>('account-username').value.trim(), password = this.el<HTMLInputElement>('account-password').value, invite = this.el<HTMLInputElement>('account-invite').value; try {
        const { response, data } = await requestJson<{
            sessionToken?: string;
            user?: {
                username: string;
            };
            error?: {
                message: string;
            };
        }>(`${gateway.replace(/\/$/, '')}/v1/auth/${register ? 'register' : 'login'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, ...(register ? { invite } : {}) }) }, { timeoutMs: 10000 });
        if (!response.ok || !data?.sessionToken)
            throw new Error(data?.error?.message || '登录失败，请检查账号、密码或邀请码。');
        if (gateway !== this.options.gateway())
            throw new Error('服务地址已经改变，请重新登录。');
        sessionStorage.setItem(this.key(), data.sessionToken);
        this.el<HTMLInputElement>('account-password').value = '';
        this.el<HTMLInputElement>('account-invite').value = '';
        this.options.changed();
        await this.update('hosted');
        this.options.notify('登录成功；笔记仍保存在当前设备。');
    }
    catch (error) {
        this.options.notify((error as Error).message);
    } }
    private async logout() { const token = this.token(); try {
        await requestJson(`${this.options.gateway().replace(/\/$/, '')}/v1/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, { timeoutMs: 5000 });
        sessionStorage.removeItem(this.key());
        this.el('account-logout').hidden = true;
        this.options.changed();
        await this.update('hosted');
        this.options.notify('本次会话已退出，设备上的笔记继续保留。');
    }
    catch {
        this.options.notify('暂时无法撤销服务器会话，请恢复网络后重试退出。');
    } }
}
