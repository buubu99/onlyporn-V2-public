# OnlyPorn Hotfix 2.5.4

## JAVHDPorn decoder IPC correction

The live v2.5.3 decoder completed with exit code 0 but the parent process could
mistake later console output from the obfuscated player script for the decoder
response. The child now uses a silent sandbox console, emits one prefixed
protocol record, and exits immediately after writing it. The parent ignores all
unmarked output and parses only the prefixed record.

SpankBang remains on the restored isolated v2.4.2 Safari transport.
