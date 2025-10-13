"use strict";

/* ioctlLogger.js — MASM action attached via Data Model 
   - Debugger.Utility.Control
   - Breakpoint body uses @$t* temps and .block
   - Prints IOCTL code/lengths/method
*/

var CTRL = null;
function bind(controlObject){ CTRL = controlObject; return "bound"; }

function _exec(cmd){
  if(!CTRL) return "ERROR: not bound (bind(Debugger.Utility.Control))";
  try {
    const out = CTRL.ExecuteCommand(cmd);
    if (!out) return "";
    if (typeof out.Length === "number") { let s=[]; for (let i=0;i<out.Length;i++) s.push(String(out[i])); return s.join("\n"); }
    let s=[]; for (const l of out) s.push(String(l)); return s.join("\n");
  } catch(e) { return String(e); }
}

function _first(re,s){ const m=String(s).match(re); return m? m[1] : null; }

function _drvObjPtr(name){
  const cands = [/^\\driver\\/i.test(name) ? name : ("\\Driver\\"+name), name];
  for(const cand of cands){
    const t=_exec("!drvobj " + cand + " 2");
    const p=_first(/Driver object\s*\(\s*([0-9A-Fa-f`]+)\s*\)\s*is\s*for:/i, t);
    if(p) return p;
  }
  return null;
}
function _dispFromText(name, mj){
  const t=_exec("!drvobj " + name + " 2"); if(!t) return null;
  const m=t.match(new RegExp(mj + "\\s+([0-9A-Fa-f`]+)\\b","i"));
  return m? m[1] : null;
}
function _dispFromDx(drvPtr, idx){
  const e="((nt!_DRIVER_OBJECT*)"+drvPtr+")->MajorFunction[0x"+idx.toString(16)+"]";
  const tries=[ "dx " + e, "?? (unsigned __int64)"+e, '.printf "0x%p\\n", ' + e ];
  for(const t of tries){
    const out=_exec(t);
    const hit=(out.match(/0x[0-9A-Fa-f`]+/g)||[])[0];
    if(hit) return hit;
  }
  return null;
}

function startIoctlLogger(name, autoContinue /* optional: default true */){
  if(!CTRL) return "ERROR: not bound (bind(Debugger.Utility.Control))";
  if(!name)  return 'Usage: startIoctlLogger("driver", /*autoContinue=*/true|false)';

  if (autoContinue === undefined) autoContinue = true;

  const drv=_drvObjPtr(name);
  let disp=_dispFromText(name,"IRP_MJ_DEVICE_CONTROL");
  if(!disp) disp=_dispFromText(name,"IRP_MJ_INTERNAL_DEVICE_CONTROL");
  if((!disp || disp==="0x0") && drv){ disp=_dispFromDx(drv,14) || _dispFromDx(drv,15); }
  if(!disp) return "No dispatch (0xE/0xF) found for " + name;

  const label = String(name).replace(/"/g,"");

  // Build MASM body as lines (your content preserved). 'gc' appended only if autoContinue==true.
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

  if (autoContinue) {
    lines.push('gc');
  }

  const body = '.block { ' + lines.join(' ; ') + ' }';

  let bpObj = null;
  try { bpObj = CTRL.SetBreakpointAtOffset(disp, 0); } catch(_) {}
  if(!bpObj){
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

  try { bpObj.Command = body; } catch(_) {}
  try { bpObj.IsEnabled = true; } catch(_) { _exec('be *'); }

  return "started for " + name + " at " + disp + "  autoContinue=" + autoContinue;
}

function stopIoctlLogger(){ return "Use 'bl' to list and 'bc <id>' to remove the breakpoint."; }
