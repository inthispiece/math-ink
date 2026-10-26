import { requestJson } from './recognition-request.ts';
import { manuscriptDigest } from './source-copy.ts';
import { canPairLocally } from './pairing.ts';
import { saveSettings, type Settings } from './model.ts';
import type { NotebookTask } from './notebook-domain.ts';
export interface ServiceStatus { provider:string;configured:boolean;simulated:boolean;local?:boolean;authMode?:string;model?:string;requestTimeoutMs?:number;taskCapabilities?:Record<string,boolean>;protocolCapabilities?:{recognitionTasks?:boolean;recognitionLookup?:boolean};quota?:unknown;budget?:unknown;limits?:unknown }
export interface Connection { gateway:string;provider:Settings['provider'];installationId:string;principal:string;token:string;status:ServiceStatus }
const clean=(gateway:string)=>gateway.replace(/\/$/,'');
/** Credentials stay in existing device credential storage, never in drafts, tasks or backups. */
export class ConnectionVault {
  private settings:Settings; private hostedToken:()=>string; private identities=new Map<string,string>();
  constructor(settings:Settings,hostedToken:()=>string){this.settings=settings;this.hostedToken=hostedToken;}
  private local(){try{return JSON.parse(localStorage.getItem('mathink-local-connections')||'{}') as Record<string,Record<string,string>>;}catch{return{};}}
  remember(gateway:string,token:string){const principal='local:'+manuscriptDigest(token),all=this.local();(all[clean(gateway)]??={})[principal]=token;localStorage.setItem('mathink-local-connections',JSON.stringify(all));return principal;}
  async prepare():Promise<Connection>{const gateway=clean(this.settings.gatewayUrl),provider=this.settings.provider;
    const {response,data}=await requestJson<ServiceStatus>(`${gateway}/v1/status?provider=${provider}`,{},{timeoutMs:8000});if(!response.ok||!data)throw new Error('识别服务暂时不可用，可返回继续书写。');
    let token=this.hostedToken();let principal:string;
    if(data.authMode==='hosted'){if(!token)throw new Error('请先在设置中登录原托管账号。');principal=await this.user(gateway,token);}
    else{token=this.settings.pairingToken.trim();if(!token&&canPairLocally(gateway,location.href)){try{const paired=await requestJson<{token?:string;pairingToken?:string}>(`${gateway}/v1/local-pairing`,{},{timeoutMs:4000});const value=paired.data?.token||paired.data?.pairingToken;if(paired.response.ok&&value){token=value;this.settings.pairingToken=value;saveSettings(this.settings);}}catch{/* The normal pairing check below explains missing access. */}}
      principal=this.remember(gateway,token);const paired=await requestJson(`${gateway}/v1/pairing`,{headers:token?{Authorization:`Bearer ${token}`}:{ }},{timeoutMs:8000});if(!paired.response.ok)throw new Error('服务配对令牌无效，请从启动窗口打开配对链接或在设置中重新配对。');}
    if(data.provider!==provider||data.simulated!==false||!data.configured)throw new Error(`当前${provider==='ollama'?'本地 Qwen':'云端模型'}尚未配置或不可用；未上传，也未扣减额度。请打开设置。`);
    return{gateway,provider,installationId:this.settings.installationId,principal,token,status:data};
  }
  private async user(gateway:string,token:string){const key=gateway+'\0'+token;const cached=this.identities.get(key);if(cached)return cached;const {response,data}=await requestJson<{user?:{id?:string}}>(`${gateway}/v1/auth/me`,{headers:{Authorization:`Bearer ${token}`}},{timeoutMs:8000});if(!response.ok||!data?.user?.id)throw new Error('原账号连接已失效，请重新登录。');const id='user:'+data.user.id;this.identities.set(key,id);return id;}
  async tokenFor(task:NotebookTask):Promise<string|null>{if(task.principal.startsWith('user:')){let token='';try{token=sessionStorage.getItem('mathink-session:'+clean(task.gateway))||'';}catch{}if(!token)return null;try{return await this.user(clean(task.gateway),token)===task.principal?token:null;}catch{return null;}}
    const token=this.local()[clean(task.gateway)]?.[task.principal];return typeof token==='string'&&'local:'+manuscriptDigest(token)===task.principal?token:null;
  }
  clearCurrent(){const all=this.local();delete all[clean(this.settings.gatewayUrl)];localStorage.setItem('mathink-local-connections',JSON.stringify(all));this.identities.clear();}
}
