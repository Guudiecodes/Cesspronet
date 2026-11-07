/* Shared helpers for every customer page */
(function(){
var SX=window.SX={};
SX.name=function(n){return String(n||"").replace(/(\d+(?:\.\d+)?)\s*(gb|mb|tb)\b/ig,function(_,a,u){return a+" "+u.toUpperCase()}).replace(/^./,function(c){return c.toUpperCase()})};
SX.valid=function(v){var m=/^\s*(\d+)\s*([hdwm])\s*$/i.exec(v||"");if(!m)return String(v||"");var n=+m[1],u=m[2].toLowerCase(),w={h:"hour",d:"day",w:"week",m:"month"}[u];return n+" "+w+(n>1?"s":"")};
SX.speed=function(rl){var p=String(rl||"").split("/"),s=p[1]||p[0]||"";var m=/^(\d+(?:\.\d+)?)\s*([kKmMgG])/.exec(s);if(!m)return s?s+"bps":"";return m[1]+" "+({k:"Kbps",m:"Mbps",g:"Gbps"})[m[2].toLowerCase()]};
SX.devices=function(n){n=+n||1;return n+(n>1?" devices":" device")};
SX.money=function(n){return"\u20A6"+Number(n||0).toLocaleString()};
var I={wifi:"M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 19.5h.01",plans:"M3 9a2 2 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a2 2 0 0 1 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1zM13 5v14",order:"M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",help:"M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"};
SX.icon=function(k){return'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+I[k]+'"/></svg>'};
SX.tabs=function(active){var q=location.search,t=[["/home.html","wifi","Home"],["/plans.html","plans","Plans"],["/verify.html","order","My order"],["/help.html","help","Help"]];
 var n=document.createElement("nav");n.className="mt";n.setAttribute("aria-label","Main");n.innerHTML=t.map(function(x){return'<a href="'+x[0]+q+'"'+(x[0]===active?' class="on" aria-current="page"':"")+">"+SX.icon(x[1])+x[2]+"</a>"}).join("");document.body.append(n);document.body.classList.add("hasmt")};
})();
