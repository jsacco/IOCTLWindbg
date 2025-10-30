"use strict";

/* ioctlLogger.js — MASM action attached via Data Model 
   - Debugger.Utility.Control
   - Breakpoint body uses @$t* temps and .block
   - Prints IOCTL code/lengths/method
   - Robust driver/dispatch lookup and IoCallDriver fallback
*/

var CTRL = null;
function bind(controlObject){ CTRL = controlObject; return "bound"; }

function _exec(cmd){
  if(!CTRL) return "ERROR: not bound (bind(Debugger.Utility.Control))";
  try {
    const out = CTRL.ExecuteCommand(cmd);
    if (!out) return "";
    // two possible shapes: collection-like or simple string
    if (typeof out.Length === "number") { let s=[]; for (let i=0;i<out.Length;i++) s.push(String(out[i])); return s.join("\n"); }
    let s=[]; for (const l of out) s.push(String(l)); return s.join("\n");
  } catch(e) { return String(e); }
}

function _first(re,s){ const m=String(s||"").match(re); return m? m[1] : null; }
function _stripTicks(s){ if(!s) return s; return String(s).replace(/`/g,"").replace(/\s+/g,"").trim(); }

// ---------- robust driver object / dispatch discovery ----------

/*
 * Try many textual forms to extract a DriverObject pointer from !drvobj output.
 * Also fall back to !devobj enumerations when helpful.
 */
function _drvObjPtr(name){
  if(!name) return null;
  const raw = String(name).trim();

  // candidate name forms to try
  const tries = [];
  if(raw.startsWith("\\Driver\\") || raw.startsWith("\\driver\\") || raw.startsWith("\\Device\\") || raw.startsWith("\\dosdevices\\")){
    tries.push(raw);
  } else {
    tries.push("\\Driver\\" + raw);
    tries.push("\\driver\\" + raw);
    tries.push(raw);                // raw name (might be used by !drvobj)
    tries.push("\\Device\\" + raw); // device variant
    tries.push("\\DosDevices\\" + raw);
  }

  // add quoted variants
  const tried = new Set();
  for(const t0 of tries){
    for(const t of [t0, '"' + t0 + '"']){
      if(tried.has(t)) continue;
      tried.add(t);
      const out = _exec("!drvobj " + t + " 2");
      if(!out) continue;

      // common canonical: "Driver object (fffff800`12345678) is for:"
      const m = out.match(/Driver object\s*\(\s*([0-9A-Fa-f`]+)\s*\)\s*is\s*for:/i);
      if(m) return _stripTicks(m[1]);

      // other forms:
      const m2 = out.match(/DriverObject\s*[:=]?\s*([0-9A-Fa-f`x]+)/i);
      if(m2) return _stripTicks(m2[1]);

      const m3 = out.match(/Driver object.*?([0-9A-Fa-f`]{8,})/i);
      if(m3) return _stripTicks(m3[1]);

      // sometimes pointer and name in same line
      const rx = new RegExp("([0-9A-Fa-f`]{8,})[^\\n\\r]*" + raw.replace(/[-\\^$*+?.()|[\]{}]/g,'\\$&'), "i");
      const m4 = out.match(rx);
      if(m4) return _stripTicks(m4[1]);
    }
  }

  // fallback: try to find a DeviceObject matching the name and read its DriverObject
  try {
    const devOut = _exec("!devobj " + raw + " 2");
    if(devOut){
      const dm = devOut.match(/Device object\s*\(\s*([0-9A-Fa-f`]+)\s*\)/i);
      if(dm){
        const devptr = _stripTicks(dm[1]);
        // use .printf to get the pointer
        const dtout = _exec('.printf "%p\\n", ((nt!_DEVICE_OBJECT*)0x' + devptr + ')->DriverObject');
        const found = (dtout.match(/0x[0-9A-Fa-f`]+/i)||[])[0];
        if(found) return _stripTicks(found);
      }
    }
  } catch(e){ /* continue */ }

  return null;
}

/*
 * Try to find dispatch pointer directly from !drvobj textual output
 * for a named driver. Looks for IRP_MJ_DEVICE_CONTROL or MajorFunction[0xE|0xF] patterns.
 *
 * mj may be "IRP_MJ_DEVICE_CONTROL" or a numeric index string.
 */
function _dispFromText(name, mj){
  if(!name) return null;
  const out = _exec("!drvobj " + name + " 2");
  if(!out) return null;

  const patterns = [
    new RegExp(mj + "\\s*[:=]\\s*([0-9A-Fa-f`]+)\\b","i"),
    new RegExp("MajorFunction\\s*\\[\\s*0x?"+ (typeof mj === 'string' ? mj.replace(/^0x/,'') : mj) + "\\s*\\]\\s*[:=]?\\s*([0-9A-Fa-f`]+)","i"),
    new RegExp("MajorFunction\\s*\\[\\s*"+ (typeof mj === 'string' ? parseInt(mj) : mj) + "\\s*\\]\\s*[:=]?\\s*([0-9A-Fa-f`]+)","i"),
    new RegExp("IRP_MJ_DEVICE_CONTROL\\s*[:=]?\\s*([0-9A-Fa-f`]+)","i"),
    new RegExp("IRP_MJ_INTERNAL_DEVICE_CONTROL\\s*[:=]?\\s*([0-9A-Fa-f`]+)","i")
  ];

  for(const p of patterns){
    const m = out.match(p);
    if(m) return _stripTicks(m[1]);
  }

  return null;
}

/*
 * Read MajorFunction[idx] from a DriverObject pointer using dx/??/dt attempts.
 * Returns the pointer as string (normalized) or null.
 */
function _dispFromDx(drvPtr, idx){
  if(!drvPtr) return null;
  let ptr = _stripTicks(String(drvPtr));
  if(!ptr.match(/^0x/i)) ptr = "0x" + ptr;

  const member = "((nt!_DRIVER_OBJECT*)" + ptr + ")->MajorFunction[0x" + idx.toString(16) + "]";
  const tries = [
    "dx " + member,
    "?? (unsigned __int64)" + member,
    '.printf "0x%p\\n", ' + member
  ];

  for(const t of tries){
    const out = _exec(t);
    if(!out) continue;
    const pick = (out.match(/0x[0-9A-Fa-f`]+/g)||[])[0];
    if(pick) return _stripTicks(pick);
  }

  // dt fallback: dump structure and try to parse MajorFunction array
  const dt = _exec("dt nt!_DRIVER_OBJECT " + ptr + " 0");
  if(dt){
    const mm = dt.match(new RegExp("MajorFunction[\\s\\S]*?\\n([\\s\\S]*?)\\n\\s*}", "i"));
    if(mm){
      const arr = mm[1].match(/0x[0-9A-Fa-f`]{8,}/g);
      if(arr && arr.length > idx) return _stripTicks(arr[idx]);
    }
  }
  return null;
}

// ---------- breakpoint helpers ----------

/*
 * Create a breakpoint on nt!IoCallDriver that filters IRPs by DriverObject pointer.
 * If autoContinue is true it will auto-continue for non-matching IRPs.
 * Returns a textual status.
 */
function _setIoCallDriverBp(drvPtr, autoContinue){
  if(!drvPtr) return "no driver ptr";
  autoContinue = (autoContinue === undefined) ? true : !!autoContinue;
  // normalize pointer string
  let p = _stripTicks(String(drvPtr));
  if(!p.match(/^0x/i)) p = "0x" + p;

  // MASM body that reads RCX (DeviceObject) and RDX (IRP) and checks DeviceObject->DriverObject
  const lines = [
    'r @$t0 = @@c++(((nt!_DEVICE_OBJECT*)@rcx)->DriverObject)',
    '.if (@$t0 == ' + p + ') {',
    '  r @$t1 = @@c++(((nt!_IRP*)@rdx)->Tail.Overlay.CurrentStackLocation)',
    '  r @$t2 = @@c++(((nt!_IO_STACK_LOCATION*)@$t1)->Parameters.DeviceIoControl.IoControlCode)',
    '  r @$t3 = @@c++(((nt!_IO_STACK_LOCATION*)@$t1)->Parameters.DeviceIoControl.InputBufferLength)',
    '  r @$t4 = @@c++(((nt!_IO_STACK_LOCATION*)@$t1)->Parameters.DeviceIoControl.OutputBufferLength)',
    '  r @$t5 = @@c++(((nt!_IRP*)@rdx)->AssociatedIrp.SystemBuffer)',
    '  r @$t6 = (@$t2 & 3)',
    '  .printf "\\n# IOCTL FOR DRIVER TRIGGERED (IoCallDriver) #\\n"',
    '  .printf "Code=0x%08x  InLen=%u  OutLen=%u  Method=%u\\n", @$t2, @$t3, @$t4, @$t6',
    '  .printf "DeviceObj=%p  IRP=%p  Caller=%p\\n", @rcx, @rdx, @rip',
    '  .printf "------------------------------------------\\n\\n"',
    '  .if (@$t6 == 3) { r @$t11 = @@c++(((nt!_IO_STACK_LOCATION*)@$t1)->Parameters.DeviceIoControl.Type3InputBuffer) } .else { r @$t11 = @@c++(((nt!_IRP*)@rdx)->AssociatedIrp.SystemBuffer) }',
    '  r @$t12 = @$t3',
    '  .if (@$t12 > 0x100) { r @$t12 = 0x100 }',
    '  .if (@$t11) { .if (@$t12) { .printf "Input Buffer @ %p (first %u bytes)\\n", @$t11, @$t12; db @$t11 L?@$t12 } .else { .echo Input: (len 0) } } .else { .echo Input: (none) }',
    '  .printf "------------------------------------------\\n\\n"',
    '  !irp @rdx 1',
    '}', // end .if
  ];

  if (autoContinue) lines.push('gc');

  const body = '.block { ' + lines.join(' ; ') + ' }';

  // try to use the control APIs first
  try {
    // prefer SetBreakpointAtOffset if available (resolves symbol)
    if(CTRL && typeof CTRL.SetBreakpointAtOffset === "function"){
      const bpObj = CTRL.SetBreakpointAtOffset("nt!IoCallDriver", 0);
      if(!bpObj) throw new Error("SetBreakpointAtOffset failed");
      try { bpObj.Command = body; } catch(e){ /* fallback */ }
      try { bpObj.IsEnabled = true; } catch(e){ /* ignore */ }
      return "IoCallDriver bp set via Control API (filtered by DriverObject " + p + ")";
    }
  } catch(e){
    // continue to CLI fallback
  }

  // fallback: plain bp and then set bp command via dx
  const bpCmd = 'bp nt!IoCallDriver';
  _exec(bpCmd);
  // find breakpoint id
  const bl = _exec('bl');
  const rows = bl.split(/\r?\n/);
  let id = null;
  const want = 'nt!iocalldriver'.toLowerCase();
  for(const r of rows){
    const m = r.match(/^\s*(\d+)\s+\w+\s+\w+\s+([0-9A-Za-z`!<>\.:_\/\\]+)\s*$/);
    if(m){
      const cand = m[2].toLowerCase().replace(/`/g,'');
      if(cand.indexOf('iocalldriver') !== -1){ id = m[1]; break; }
      if(!id) id = m[1];
    }
  }
  if(!id) return "Failed to create IoCallDriver bp (bl output):\n" + bl;
  // set command
  _exec('dx Debugger.Breakpoints['+id+'].Command = "' + body.replace(/"/g,'""') + '"');
  _exec('be ' + id);
  return "IoCallDriver bp set (bp " + id + ") filtered by DriverObject " + p;
}


// ---------- main API: start/stop ----------

function startIoctlLogger(name, autoContinue /* optional: default true */){
  if(!CTRL) return "ERROR: not bound (bind(Debugger.Utility.Control))";
  if(!name)  return 'Usage: startIoctlLogger("driver", /*autoContinue=*/true|false)';

  if (autoContinue === undefined) autoContinue = true;

  const drv = _drvObjPtr(name);
  let disp = _dispFromText(name,"IRP_MJ_DEVICE_CONTROL");
  if(!disp) disp = _dispFromText(name,"IRP_MJ_INTERNAL_DEVICE_CONTROL");
  if((!disp || disp==="0x0" || /^0+$/.test(disp)) && drv){
    // attempt to read MajorFunction entries via dx
    const tryE = _dispFromDx(drv, 0xE);
    const tryF = _dispFromDx(drv, 0xF);
    if(tryE) disp = tryE;
    else if(tryF) disp = tryF;
  }

  // If no dispatch found, fallback to IoCallDriver bp (covers all IRPs to that driver's device objects)
  if(!disp){
    if(!drv) return "No dispatch found and no driver object pointer for '" + name + "'; try '!drvobj " + name + " 2' manually.";
    // set IoCallDriver bp filtered by DriverObject
    const msg = _setIoCallDriverBp(drv, autoContinue);
    return "No per-major dispatch found for " + name + ". Fallback: " + msg;
  }

  // dispatch found; set breakpoint at that address/offset
  const label = String(name).replace(/"/g,"");

  // Build MASM body as lines (original content preserved). 'gc' appended only if autoContinue==true.
  const lines = [
    // gather
    'r @$t0 = @@c++(((nt!_IRP*)@rdx)->Tail.Overlay.CurrentStackLocation)',
    'r @$t1 = @@c++(((nt!_IO_STACK_LOCATION*)@$t0)->Parameters.DeviceIoControl.IoControlCode)',
    'r @$t2 = @@c++(((nt!_IO_STACK_LOCATION*)@$t0)->Parameters.DeviceIoControl.InputBufferLength)',
    'r @$t3 = @@c++(((nt!_IO_STACK_LOCATION*)@$t0)->Parameters.DeviceIoControl.OutputBufferLength)',
    'r @$t4 = @@c++(((nt!_IO_STACK_LOCATION*)@$t0)->Parameters.DeviceIoControl.Type3InputBuffer)',
    'r @$t5 = @@c++(((nt!_IRP*)@rdx)->AssociatedIrp.SystemBuffer)',
    'r @$t6 = (@$t1 & 3)',
    // header
    '.printf "\\n# IOCTL FOR DRIVER TRIGGERED: ' + label + ' #\\n"',
    '.printf "Code=0x%08x  InLen=%u  OutLen=%u  Method=%u\\n", @$t1, @$t2, @$t3, @$t6',
    '.printf "IRP=%p  DevObj=%p  RIP=%p\\n", @rdx, @rcx, @rip',
    '.printf "------------------------------------------\\n\\n"',
    '.printf "# DUMP OF BUFFER CONTENT FOR IOCTL: 0x%08x \\n", @$t1',
    // choose input buffer for METHOD_NEITHER vs others
    '.if (@$t6 == 3) { r @$t11 = @$t4 } .else { r @$t11 = @$t5 }',
    'r @$t12 = @$t2',
    '.if (@$t12 > 0x100) { r @$t12 = 0x100 }',
    // nested .if (no &&)
    '.if (@$t11) { .if (@$t12) { .printf "Input Buffer @ %p (first %u bytes)\\n", @$t11, @$t12; db @$t11 L?@$t12 } .else { .echo Input: (len 0) } } .else { .echo Input: (none) }',
    '.printf "------------------------------------------\\n\\n"',
    // irp summary
    '!irp @rdx 1'
  ];

  if (autoContinue) lines.push('gc');

  const body = '.block { ' + lines.join(' ; ') + ' }';

  // attempt to set bp via control API
  let bpObj = null;
  try { bpObj = CTRL.SetBreakpointAtOffset(disp, 0); } catch(_) {}
  if(!bpObj){
    // fallback to textual bp + assign command
    _exec('bp ' + disp);
    const bl=_exec('bl');
    const rows = bl.split(/\r?\n/);
    let id=null, want=disp.toLowerCase().replace(/`/g,'');
    for(const r of rows){
      const m=r.match(/^\s*(\d+)\s+\w\s+\w+\s+([0-9A-Fa-f`]+)/);
      if(m){
        const cand=m[2].toLowerCase().replace(/`/g,'');
        if(cand===want){ id=m[1]; break; }
        id=m[1];
      }
    }
    if(id===null) return "Failed to create breakpoint at " + disp + "\n" + bl;
    _exec('dx Debugger.Breakpoints['+id+'].Command = "'+ body.replace(/"/g,'""') + '"');
    _exec('be ' + id);
    return "started for " + name + " at " + disp + " (bp " + id + ")  autoContinue=" + autoContinue;
  }

  // we have a bp object via control API
  try { bpObj.Command = body; } catch(_) {}
  try { bpObj.IsEnabled = true; } catch(_) { _exec('be *'); }

  return "started for " + name + " at " + disp + "  autoContinue=" + autoContinue;
}

function stopIoctlLogger(){ return "Use 'bl' to list and 'bc <id>' to remove the breakpoint."; }

// expose functions (if running as a module)
try {
  module.exports = {
    bind: bind,
    startIoctlLogger: startIoctlLogger,
    stopIoctlLogger: stopIoctlLogger
  };
} catch(e){ /* Not Node — ignore */ }
