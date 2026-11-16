/* Shared by every BSL app. Set window.BSL_PREFIX before loading this file. */
/* ---- BSL standalone storage layer (replaces Claude's built-in database) ----
   Mode 1: Firebase (shared between all staff) - fill in firebase-config.js
   Mode 2: Test mode (data kept in this browser only) - used when firebase-config.js is not filled in */
(function(){
  var PREFIX = window.BSL_PREFIX || 'app_';
  var FB = window.BSL_FIREBASE || null;
  var useFirebase = !!(FB && FB.apiKey && FB.apiKey.indexOf('YOUR_')!==0);
  var ready = null, fbUserName = null, dbWrapper = null;

  function el(html){ var d=document.createElement('div'); d.innerHTML=html; return d.firstElementChild; }
  function loadScript(src){ return new Promise(function(res,rej){ var s=document.createElement('script'); s.src=src; s.onload=res; s.onerror=function(){rej(new Error('Could not load '+src));}; document.head.appendChild(s); }); }
  function overlay(inner){
    var o=el('<div style="position:fixed;inset:0;background:rgba(20,18,14,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,sans-serif;"><div style="background:#fff;color:#1C2230;border-radius:10px;padding:24px;width:100%;max-width:340px;box-shadow:0 8px 30px rgba(0,0,0,.3);">'+inner+'</div></div>');
    document.body.appendChild(o); return o;
  }
  var inputStyle='width:100%;padding:10px;margin:6px 0 10px;border:1px solid #ccc;border-radius:5px;font-size:14px;box-sizing:border-box;';
  var btnStyle='width:100%;padding:11px;background:#1C2230;color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;';

  /* ---------- Test mode (localStorage) ---------- */
  function localDb(){
    var KEY='bsl_local_'+PREFIX, listeners={};
    function load(){ try{ return JSON.parse(localStorage.getItem(KEY)||'{}'); }catch(e){ return {}; } }
    function save(d){ localStorage.setItem(KEY, JSON.stringify(d)); }
    function clone(x){ return x===undefined?undefined:JSON.parse(JSON.stringify(x)); }
    function snapFor(name){
      var col=load()[name]||{};
      return {docs:Object.keys(col).map(function(id){ return {id:id, data:function(){return clone(col[id]);}}; })};
    }
    function notify(name){ (listeners[name]||[]).forEach(function(cb){ try{cb(snapFor(name));}catch(e){console.error(e);} }); }
    window.addEventListener('storage',function(e){ if(e.key===KEY) Object.keys(listeners).forEach(notify); });
    function split(path){ var i=path.indexOf('/'); return [path.slice(0,i), path.slice(i+1)]; }
    function strip(o){ return clone(o); }
    return {
      collection:function(name){ return {
        onSnapshot:function(ok){ (listeners[name]=listeners[name]||[]).push(ok); setTimeout(function(){ok(snapFor(name));},0); return function(){}; }
      };},
      doc:function(path){ var p=split(path), c=p[0], id=p[1]; return {
        get:function(){ var d=load(); var v=(d[c]||{})[id]; return Promise.resolve({exists:v!==undefined, id:id, data:function(){return clone(v);}}); },
        set:function(data){ var d=load(); d[c]=d[c]||{}; d[c][id]=strip(data); save(d); notify(c); return Promise.resolve(); },
        update:function(data){ var d=load(); d[c]=d[c]||{}; if(d[c][id]===undefined) return Promise.reject(new Error('Document not found')); var cur=d[c][id]; Object.keys(data).forEach(function(k){ cur[k]=strip(data[k]); }); save(d); notify(c); return Promise.resolve(); },
        delete:function(){ var d=load(); if(d[c]) delete d[c][id]; save(d); notify(c); return Promise.resolve(); }
      };}
    };
  }

  /* ---------- Firebase mode ---------- */
  function firebaseDb(){
    var V='10.12.2', base='https://www.gstatic.com/firebasejs/'+V+'/';
    return loadScript(base+'firebase-app-compat.js').then(function(){
      return Promise.all([loadScript(base+'firebase-firestore-compat.js'), loadScript(base+'firebase-auth-compat.js')]);
    }).then(function(){
      firebase.initializeApp(FB);
      var fdb=firebase.firestore();
      try{ fdb.settings({ignoreUndefinedProperties:true}); }catch(e){}
      return new Promise(function(resolve){
        var shown=null;
        firebase.auth().onAuthStateChanged(function(user){
          if(user){
            if(shown){ shown.remove(); shown=null; }
            fbUserName = user.displayName || (user.email||'Staff').split('@')[0];
            resolve(fdb);
          } else if(!shown){
            shown=overlay('<h3 style="margin:0 0 4px;">Staff sign in</h3><div style="font-size:12.5px;color:#666;margin-bottom:8px;">Use the email and password given by your administrator.</div>'+
              '<input id="bslEm" type="email" placeholder="Email" style="'+inputStyle+'"><input id="bslPw" type="password" placeholder="Password" style="'+inputStyle+'">'+
              '<div id="bslErr" style="color:#b00020;font-size:12.5px;min-height:16px;margin-bottom:6px;"></div><button id="bslGo" style="'+btnStyle+'">Sign in</button>');
            var go=function(){
              var em=shown.querySelector('#bslEm').value.trim(), pw=shown.querySelector('#bslPw').value;
              shown.querySelector('#bslErr').textContent='';
              firebase.auth().signInWithEmailAndPassword(em,pw).catch(function(e){ shown.querySelector('#bslErr').textContent='Sign-in failed: check email and password.'; });
            };
            shown.querySelector('#bslGo').onclick=go;
            shown.querySelector('#bslPw').addEventListener('keydown',function(e){ if(e.key==='Enter') go(); });
          }
        });
      });
    }).then(function(fdb){
      function split(path){ var i=path.indexOf('/'); return [path.slice(0,i), path.slice(i+1)]; }
      return {
        collection:function(name){ return { onSnapshot:function(ok,err){ return fdb.collection(PREFIX+name).onSnapshot(ok,err); } }; },
        doc:function(path){ var p=split(path); var r=fdb.collection(PREFIX+p[0]).doc(p[1]); return {
          get:function(){ return r.get(); }, set:function(d){ return r.set(d); }, update:function(d){ return r.update(d); }, delete:function(){ return r.delete(); }
        };}
      };
    });
  }

  function askName(){
    return new Promise(function(resolve){
      var saved=null; try{ saved=localStorage.getItem('bsl_staff_name'); }catch(e){}
      if(saved){ resolve(saved); return; }
      var o=overlay('<h3 style="margin:0 0 6px;">Your name</h3><div style="font-size:12.5px;color:#666;">Shown on bills and the activity log.</div><input id="bslNm" placeholder="e.g. Rahim" style="'+inputStyle+'"><button id="bslOk" style="'+btnStyle+'">Continue</button>');
      var go=function(){ var v=o.querySelector('#bslNm').value.trim()||'Staff'; try{localStorage.setItem('bsl_staff_name',v);}catch(e){} o.remove(); resolve(v); };
      o.querySelector('#bslOk').onclick=go; o.querySelector('#bslNm').addEventListener('keydown',function(e){ if(e.key==='Enter') go(); });
    });
  }

  function getDb(){
    if(ready) return ready;
    if(useFirebase){ ready=firebaseDb().then(function(d){ dbWrapper=d; return d; }); }
    else {
      ready=askName().then(function(n){ fbUserName=n; dbWrapper=localDb();
        var b=el('<div style="position:fixed;bottom:0;left:0;right:0;background:#B4790F;color:#fff;font:12px system-ui,sans-serif;padding:5px 10px;text-align:center;z-index:99998;">TEST MODE — data is saved in this browser only. Fill in firebase-config.js to share data between staff.</div>');
        document.body.appendChild(b); return dbWrapper; });
    }
    return ready;
  }

  window.claude = { use:function(name){
    if(name==='db') return getDb();
    if(name==='user') return getDb().then(function(){ return {
      me:function(){ return Promise.resolve('me'); },
      profiles:function(){ var o={}; o.me={name:fbUserName||'Staff'}; return Promise.resolve(o); }
    };});
    if(name==='downloads') return Promise.resolve({
      save:function(req){
        return new Promise(function(res){
          var blob=(req.data instanceof Blob)?req.data:new Blob([req.data]);
          var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=req.filename||'download';
          document.body.appendChild(a); a.click(); setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); },500);
          res({status:'saved'});
        });
      }});
    return Promise.resolve(null);
  }};
})();
