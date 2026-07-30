# Deploy alpha.14 R4

Use the separately supplied R4 ZIP and R4 deployment script. The script first
runs the real live Sukebei adapter directly from the extracted candidate. This
happens before any Git reset, stash, copy, commit, GitHub push, or Render deploy.

Only after that live gate succeeds does the script install the candidate into
the local repository, run the retained test suite, verify all metadata-first
catalogs, push a candidate branch, push `main`, and verify Render.
