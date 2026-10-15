'use strict';
let mockMode, mockStats;
jest.mock('sharp',()=>jest.fn());
jest.mock('node-cron',()=>({schedule:jest.fn()}));
jest.mock('worker_threads',()=>({Worker:class {
 constructor(){this.handlers={};setImmediate(()=>{
  if(mockMode==='exit')this.handlers.exit?.(1);
  else if(mockMode==='thread')this.handlers.error(new Error('thread crashed'));
  else this.handlers.message(mockMode==='ok'?{stats:mockStats}:{error:'decode failed'});
 });}
 once(name,fn){this.handlers[name]=fn;return this;}
}}));
jest.mock('fs',()=>({existsSync:()=>true,mkdirSync:jest.fn(),promises:{stat:jest.fn(async()=>({size:100})),unlink:jest.fn(async()=>{})}}));
jest.mock('../../repositories/remote-sensing.repository',()=>({findPendingJobs:jest.fn(),findFilesByImageId:jest.fn(),updateJobStatus:jest.fn(),updateImage:jest.fn(),upsertStatistics:jest.fn()}));
jest.mock('../../services/minio.service',()=>({downloadToFile:jest.fn()}));
jest.mock('../../utils/i18n.util',()=>({t:key=>key}));
jest.mock('../../realtime/websocket.server',()=>({notifyChannel:jest.fn(),notifyUser:jest.fn()}));
const repo=require('../../repositories/remote-sensing.repository');const ws=require('../../realtime/websocket.server');const worker=require('../imageProcessing.worker');
beforeEach(()=>{jest.clearAllMocks();mockMode='ok';mockStats=[{band_index:1,mean:10}];repo.upsertStatistics.mockReset();
 repo.findPendingJobs.mockResolvedValue([{id:1,image_id:2,job_type:'calc_statistics',attempt_count:0,max_attempts:1}]);
 repo.findFilesByImageId.mockResolvedValue([{id:3,file_role:'primary',original_name:'test.tif'},{file_role:'thumbnail'}]);
});
test.each(['decode','thread','exit','empty','malformed','persist-second-band'])('F25 required statistics %s failure must never complete image',async mode=>{
 mockMode=mode;if(mode==='empty'){mockMode='ok';mockStats=[];}if(mode==='malformed'){mockMode='ok';mockStats=undefined;}
 if(mode==='persist-second-band'){mockMode='ok';mockStats=[{band_index:1},{band_index:2}];repo.upsertStatistics.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('DB write failed'));}
 await worker.runOnce();
 expect(repo.updateJobStatus.mock.calls.some(c=>c[1]==='failed')).toBe(true);
 expect(repo.updateJobStatus.mock.calls.some(c=>c[1]==='completed')).toBe(false);
 expect(ws.notifyChannel.mock.calls.some(c=>['remote_sensing:statistics_ready','remote_sensing:job_completed'].includes(c[1]))).toBe(false);
});
test('successful statistics retains existing completion lifecycle',async()=>{await worker.runOnce();expect(repo.updateJobStatus.mock.calls.some(c=>c[1]==='completed')).toBe(true);});
