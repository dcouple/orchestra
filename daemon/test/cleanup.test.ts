import {execFileSync} from "node:child_process";
import {existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it} from "vitest";
import {CleanupWorker} from "../src/cleanup.js";
import {EventLog} from "../src/eventlog.js";
import type {LinearGateway,PostResult} from "../src/linear.js";
import {WorktreeManager} from "../src/worktrees.js";

const dirs:string[]=[]; afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function git(args:string[],cwd?:string){execFileSync("git",args,{cwd,stdio:"ignore"});}
async function setup(){
  const dir=mkdtempSync(join(tmpdir(),"cleanup-"));dirs.push(dir);const seed=join(dir,"seed"),origin=join(dir,"origin.git"),repo=join(dir,"repo"),root=join(dir,"trees");
  mkdirSync(seed);git(["init","-b","main"],seed);git(["config","user.email","test@example.com"],seed);git(["config","user.name","Test"],seed);
  git(["commit","--allow-empty","-m","initial"],seed);git(["clone","--bare",seed,origin]);git(["clone",origin,repo]);
  const log=new EventLog(join(dir,"events.db"));const manager=new WorktreeManager(root,repo);const tree=await manager.ensureWorktree("ENG-42");
  log.append({deliveryId:"impl",app:"implementer",action:"created",agentSessionId:"session",issueId:"issue",issueIdentifier:"ENG-42",receivedAt:1,rawBody:Buffer.from("{}")});
  log.updateSessionWorktree("session",tree.path,tree.branch,2);const turn=log.claimNextTurn(2)!;log.finishTurn(turn.id,"response","done",2);log.markTurnActivityPosted(turn.id,2);return {dir,repo,root,log,tree};
}
class Poster{posts:string[]=[];async postActivity(_a:string,_s:string,_id:string,c:{body:string}):Promise<PostResult>{this.posts.push(c.body);return {ok:true};}}
function complete(log:EventLog){log.append({deliveryId:"done",app:"implementer",action:"update",type:"Issue",stateType:"completed",issueId:"issue",issueIdentifier:"ENG-42",receivedAt:3,rawBody:Buffer.from("{}")});}
async function waitFor(p:()=>boolean){const end=Date.now()+3000;while(!p()){if(Date.now()>end)throw new Error("timeout");await new Promise(r=>setTimeout(r,10));}}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}

describe("CleanupWorker",()=>{
  it("AC5 removes a clean worktree and branch with a recorded external URL, including ignored attachments",async()=>{const s=await setup();mkdirSync(join(s.tree.path,".linear-attachments"));writeFileSync(join(s.tree.path,".linear-attachments","a"),"x");s.log.stageExternalUrl("session","implementer","Pull Request","https://github.com/dcouple/example/pull/42",3);complete(s.log);
    const worker=new CleanupWorker(s.log,new Poster() as unknown as LinearGateway,s.root,s.repo,{pollMs:10,reconcileMs:20});worker.start();await waitFor(()=>s.log.cleanupStates()[0]?.status==="done");await worker.stop();
    expect(existsSync(s.tree.path)).toBe(false);expect(()=>git(["show-ref","--verify","refs/heads/agents/ENG-42"],s.repo)).toThrow();s.log.close();});
  it("retains a clean present worktree when no pull request URL was recorded",async()=>{const s=await setup();complete(s.log);const poster=new Poster();
    const worker=new CleanupWorker(s.log,poster as unknown as LinearGateway,s.root,s.repo,{pollMs:10,reconcileMs:20});worker.start();await waitFor(()=>s.log.cleanupNotificationStates()[0]?.status==="posted");await worker.stop();
    expect(s.log.cleanupStates()[0]?.status).toBe("retained");expect(poster.posts[0]).toContain("no pull request was recorded");expect(poster.posts[0]).toContain(s.tree.path);expect(existsSync(s.tree.path)).toBe(true);s.log.close();});
  it("AC6 retains a dirty worktree and durably posts its path",async()=>{const s=await setup();writeFileSync(join(s.tree.path,"dirty.txt"),"x");complete(s.log);const poster=new Poster();
    const worker=new CleanupWorker(s.log,poster as unknown as LinearGateway,s.root,s.repo,{pollMs:10,reconcileMs:20});worker.start();await waitFor(()=>s.log.cleanupNotificationStates()[0]?.status==="posted");await worker.stop();
    expect(s.log.cleanupStates()[0]?.status).toBe("retained");expect(poster.posts[0]).toContain(s.tree.path);expect(existsSync(s.tree.path)).toBe(true);s.log.close();});
  it("reclaims an expired running job after restart",async()=>{const s=await setup();s.log.stageExternalUrl("session","implementer","Pull Request","https://github.com/dcouple/example/pull/42",3);complete(s.log);expect(s.log.claimNextCleanup(10)).toBeDefined();
    const worker=new CleanupWorker(s.log,new Poster() as unknown as LinearGateway,s.root,s.repo,{pollMs:10,reconcileMs:20,leaseMs:1,now:()=>20});worker.start();await waitFor(()=>s.log.cleanupStates()[0]?.status==="done");await worker.stop();s.log.close();});
  it("reclaims a fresh running cleanup at startup so same-issue turns are not wedged",async()=>{const s=await setup();s.log.stageExternalUrl("session","implementer","Pull Request","https://github.com/dcouple/example/pull/42",3);complete(s.log);expect(s.log.claimNextCleanup(10)).toBeDefined();
    s.log.append({deliveryId:"planner",app:"planner",action:"created",agentSessionId:"planner-session",issueId:"issue",issueIdentifier:"ENG-42",receivedAt:11,rawBody:Buffer.from("{}")});
    expect(s.log.claimNextTurn(12)).toBeUndefined();
    const worker=new CleanupWorker(s.log,new Poster() as unknown as LinearGateway,s.root,s.repo,{pollMs:1000,reconcileMs:1000,now:()=>12});worker.start();
    expect(s.log.cleanupStates()[0]?.status).toBe("pending");expect(s.log.claimNextTurn(13)).toMatchObject({linearSessionId:"planner-session"});await worker.stop();s.log.close();});
  it("does not reclaim a running cleanup during periodic reconcile",async()=>{const s=await setup();s.log.stageExternalUrl("session","implementer","Pull Request","https://github.com/dcouple/example/pull/42",3);complete(s.log);
    let now=10;const worker=new CleanupWorker(s.log,new Poster() as unknown as LinearGateway,s.root,s.repo,{pollMs:1000,reconcileMs:1000,leaseMs:1,now:()=>now});
    const internals=worker as unknown as {worktrees:{remove(issueIdentifier:string):Promise<void>};reconcile():Promise<void>};
    const originalRemove=internals.worktrees.remove.bind(internals.worktrees);const started=deferred();const release=deferred();
    internals.worktrees.remove=async(issueIdentifier:string)=>{started.resolve();await release.promise;await originalRemove(issueIdentifier);};
    const drain=worker.trigger();await started.promise;expect(s.log.cleanupStates()[0]?.status).toBe("running");
    now=20;const reconcile=internals.reconcile();await Promise.resolve();expect(s.log.cleanupStates()[0]?.status).toBe("running");
    release.resolve();await Promise.all([drain,reconcile]);expect(s.log.cleanupStates()[0]?.status).toBe("done");s.log.close();});
  it("finishes crash recovery when the worktree is already removed but its branch remains",async()=>{const s=await setup();complete(s.log);git(["worktree","remove",s.tree.path],s.repo);
    const worker=new CleanupWorker(s.log,new Poster() as unknown as LinearGateway,s.root,s.repo,{pollMs:10,reconcileMs:20});worker.start();await waitFor(()=>s.log.cleanupStates()[0]?.status==="done");await worker.stop();
    expect(()=>git(["show-ref","--verify","refs/heads/agents/ENG-42"],s.repo)).toThrow();s.log.close();});
});
