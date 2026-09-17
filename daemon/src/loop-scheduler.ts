import type { EventLog, LoopOccurrenceRow } from "./eventlog.js";
export class LoopScheduler {
  private timer:NodeJS.Timeout|undefined; private stopped=true; private ticking:Promise<LoopOccurrenceRow[]>|undefined;
  constructor(private log:EventLog,private options:{intervalMs?:number;now?:()=>number;wake:()=>void|Promise<void>}){}
  start():void{if(!this.stopped)return;this.stopped=false;this.timer=setInterval(()=>void this.trigger(),this.options.intervalMs??15_000);this.timer.unref();void this.trigger();}
  trigger():Promise<LoopOccurrenceRow[]>{if(this.stopped)return Promise.resolve([]);return this.ticking??=(async()=>{const rows=this.log.admitDueLoops((this.options.now??Date.now)());if(rows.length&&!this.stopped)await this.options.wake();return rows;})().finally(()=>{this.ticking=undefined;});}
  async stop():Promise<void>{this.stopped=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.ticking;}
}
