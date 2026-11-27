const $=id=>document.getElementById(id);
async function refresh(){
 const r=await chrome.runtime.sendMessage({kind:"status"});const list=$("pairings");list.replaceChildren();
 for(const p of r.pairings||[]){
  const row=document.createElement("div");const label=document.createElement("p");label.textContent=p.campaign+" — "+p.world+" ("+(p.connected?"connected":"waiting")+") · "+p.origin;
  const remove=document.createElement("button");remove.textContent="Unpair";remove.onclick=async()=>{const r=await chrome.runtime.sendMessage({kind:"forget",origin:p.origin,world:p.world});$("status").textContent=r.error||r.status;await refresh();};row.append(label,remove);list.append(row);
 }
}
$("connect").onclick=async()=>{try{
 const [tab]=await chrome.tabs.query({active:true,currentWindow:true});const campaign=$("campaign").value.trim(),secret=$("secret").value.trim();
 if(!campaign||!secret)throw Error("Enter campaign and key");
 const url=new URL(tab.url);if(!["http:","https:"].includes(url.protocol))throw Error("Open your Foundry GM tab first");
 // The request is made directly from this user gesture; permission is origin-specific.
 if(!await chrome.permissions.request({origins:[url.origin+"/*"]}))throw Error("Site access was not granted");
 const r=await chrome.runtime.sendMessage({kind:"connect",tabId:tab.id,campaign,secret});
 $("status").textContent=r.error||r.status;$("secret").value="";await refresh();
 }catch(e){$("status").textContent=e.message;}};
$("reconnect").onclick=async()=>{const r=await chrome.runtime.sendMessage({kind:"reconnect"});$("status").textContent=r.error||r.status;await refresh();};
void refresh();
