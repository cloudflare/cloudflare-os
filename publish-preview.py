from pathlib import Path
import subprocess,json,hashlib
r=Path('/private/tmp/cfos-binary-stack-20261106');p=r/'public-preview';heads=json.loads((r/'published-heads.json').read_text())
def run(*args):return subprocess.check_output(['git',*args],cwd=p,text=True).strip()
assert run('rev-parse','HEAD')=='441ecc468dea31ecf72b6f56c0ee3d6214a2a892'
assert not run('diff','--cached','--name-only')
paths=run('diff','--name-only').splitlines();extra=run('ls-files','--others','--exclude-standard').splitlines()
files={name:(p/name).read_bytes() for name in paths+extra}
backup=r/'preview-validated';backup.mkdir(exist_ok=True)
for name,data in files.items():
 dest=backup/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data)
run('restore','--worktree','--',*paths)
for name in extra:(p/name).unlink()
run('switch','-c','ddr/container-binary-live-preview')
result=subprocess.run(['git','merge','--no-commit','--no-ff',heads['public759']],cwd=p,capture_output=True,text=True)
print(result.stdout,result.stderr)
if result.returncode not in [0,1]:raise RuntimeError('Merge could not start')
unmerged=set(run('diff','--name-only','--diff-filter=U').splitlines())
assert unmerged.issubset(files),unmerged
for name,data in files.items():
 dest=p/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data)
run('add','--',*files)
assert set(run('diff','--cached','--name-only').splitlines()).issubset(files)
assert not run('diff','--name-only','--diff-filter=U')
for name,data in files.items():assert (p/name).read_bytes()==data,name
run('diff','--cached','--check')
print(run('commit','-m','Merge binary worktree uploads into the container preview'))
head=run('rev-parse','HEAD');heads['publicPreview']=head;heads['oldPublicPreview']='441ecc468dea31ecf72b6f56c0ee3d6214a2a892';heads['previewBranch']='ddr/container-binary-live-preview'
(r/'published-heads.json').write_text(json.dumps(heads,indent=2)+'\n')
print(run('log','-1','--format=%H%n%P'));print('Validated preview file contents preserved exactly.')
