## WinDBG Plugin for Windows Kernel Exploitation.
## By Juan Sacco <<jsacco@exploitpack.com> https://exploitpack.com

This WinDBG Plugin traps and log the IOCTLs on real-time from the target driver/module, sets a breakpoint into IRP_MJ_DEVICE_CONTROL to break or pass, and once you trigger the IOCTL from the user-mode targeted app, it shows you the corresponding values of the IOCTL, method, access type, buffer in/out and the content of the buffer among other things.
How to use:
1. Copy IOCTLWingb plugin to c:\WinDBG\
2. Unload if previously loaded in WinDBG:
   .scriptunload C:\WinDBG\ioctlLogger.js
4. Load the script:
   .scriptload C:\WinDBG\ioctlLogger.js
5. Bind the JS:
   dx Debugger.State.Scripts.ioctlLogger.Contents.bind(Debugger.Utility.Control)
6. Start the script, mandatory arguments (Devicename, break true/false)
   dx Debugger.State.Scripts.ioctlLogger.Contents.startIoctlLogger("DeviceName", false)

What is WinDBG?
WinDbg (Windows Debugger) is a powerful debugger from Microsoft that allows users to debug live user-mode and kernel-mode applications and drivers, analyze crash dumps, and examine CPU registers and memory on Windows systems. It includes features like a modern user interface, scripting, a data model for complex analysis, and Time Travel Debugging (TTD) for advanced troubleshooting of crashes and system hangs

Download WinDBG from Microsoft site: [Download WinDBG](https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/)

<img src="https://cdn.shopify.com/s/files/1/0918/4162/6445/files/Screenshot_from_2025-10-07_16-15-05.png?v=1759846530">
In the following screenshot you can see the plugin in action, were an IOCTL has been captured in real-time, displaying and logging all the critical values for building an exploit:
<img src="https://cdn.shopify.com/s/files/1/0918/4162/6445/files/1759771820191.jpg?v=1759846450">

Quite a handy tool to have in your arsenal while writing kernel exploits ;-)
