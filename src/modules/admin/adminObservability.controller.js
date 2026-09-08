/**
 * Phase 8 — Admin Observability API layer
 * Additive, read-only. Reuses existing telemetry models.
 * All routes under requireAuth+requireAdmin.
 */
const ApiResponse = require('../../utils/ApiResponse');
const ApiError = require('../../utils/ApiError');
const asyncHandler = require('../../utils/asyncHandler');
const QueryLog = require('../queryLog/queryLog.model');
const AgentLog = require('./agentLog.model');
const TokenUsage = require('./tokenUsage.model');
const ExternalApiLog = require('./externalApiLog.model');

function parseDateParam(v){
  if(!v) return null;
  const d = new Date(v);
  if(isNaN(d)) throw new ApiError(400, `Invalid date: ${v}`);
  return d;
}

// GET /admin/searches?from=&to=&resultSource=&q=&limit=&offset=
const listSearches = asyncHandler(async (req,res)=>{
  const { from, to, resultSource, q, limit: rawLimit, offset: rawOffset } = req.query;
  const limit = Math.min(Math.max(parseInt(rawLimit,10)||20,1),100);
  const offset = Math.max(parseInt(rawOffset,10)||0,0);
  const filter={};
  if(from || to){
    filter.createdAt={};
    if(from) filter.createdAt.$gte = parseDateParam(from);
    if(to) filter.createdAt.$lte = parseDateParam(to);
  }
  if(resultSource){
    const allowed=['cache','fallback','merged','out_of_domain'];
    if(!allowed.includes(resultSource)) throw new ApiError(400, `resultSource must be one of ${allowed.join(',')}`);
    filter.resultSource=resultSource;
  }
  if(q){
    filter.rawQuery={ $regex: String(q).slice(0,200), $options:'i' };
  }
  const [items, total] = await Promise.all([
    QueryLog.find(filter).sort({createdAt:-1}).skip(offset).limit(limit).lean(),
    QueryLog.countDocuments(filter),
  ]);
  return new ApiResponse(200, { items, total, limit, offset }).send(res);
});

// GET /admin/searches/:requestId — correlated detail
const getSearchDetail = asyncHandler(async (req,res)=>{
  const { requestId } = req.params;
  if(!requestId) throw new ApiError(400,'requestId required');
  const [queryLog, agentLogs, tokenUsages, externalLogs] = await Promise.all([
    QueryLog.findOne({requestId}).lean(),
    AgentLog.find({requestId}).sort({createdAt:1}).lean(),
    TokenUsage.find({requestId}).sort({createdAt:1}).lean(),
    ExternalApiLog.find({requestId}).sort({createdAt:1}).lean(),
  ]);
  if(!queryLog && agentLogs.length===0 && tokenUsages.length===0 && externalLogs.length===0){
    throw new ApiError(404,'No telemetry found for requestId');
  }
  // Enrich tokens with cost (reuse Phase 6)
  let enrichedTokens = tokenUsages;
  try{
    const { calculateLlmCostForRecord } = require('../../services/cost.service');
    enrichedTokens = tokenUsages.map(t=>{
      const c=calculateLlmCostForRecord(t);
      return {...t, cost:{ totalCost:c.totalCost, inputCost:c.inputCost, outputCost:c.outputCost, isEstimated:c.isEstimated, costAvailable:c.costAvailable, reason:c.reason }};
    });
  }catch{}
  // Cost via service if any tokens/external exist
  let cost=null;
  try{
    const { calculateCostForRecords } = require('../../services/cost.service');
    cost = calculateCostForRecords(tokenUsages, externalLogs);
  }catch{}

  return new ApiResponse(200, {
    requestId,
    queryLog,
    agentLogs,
    tokenUsages: enrichedTokens,
    externalLogs,
    cost,
    timings: queryLog?.timings || null,
    provenance: queryLog?.provenance || null,
  }).send(res);
});

// GET /admin/external-logs?service=&status=&from=&to=&limit=&offset=&requestId=
const listExternalLogs = asyncHandler(async (req,res)=>{
  const { service, status, from, to, limit: rawLimit, offset: rawOffset, requestId } = req.query;
  const limit = Math.min(Math.max(parseInt(rawLimit,10)||50,1),200);
  const offset = Math.max(parseInt(rawOffset,10)||0,0);
  const filter={};
  if(service) filter.service = String(service);
  if(status){
    if(!['success','error'].includes(status)) throw new ApiError(400,'status must be success or error');
    filter.status=status;
  }
  if(requestId) filter.requestId=String(requestId);
  if(from || to){
    filter.createdAt={};
    if(from) filter.createdAt.$gte = parseDateParam(from);
    if(to) filter.createdAt.$lte = parseDateParam(to);
  }
  const [items, total, agg] = await Promise.all([
    ExternalApiLog.find(filter).sort({createdAt:-1}).skip(offset).limit(limit).lean(),
    ExternalApiLog.countDocuments(filter),
    ExternalApiLog.aggregate([
      {$match: filter},
      {$group:{_id:null, avgMs:{$avg:'$durationMs'}, maxMs:{$max:'$durationMs'}, minMs:{$min:'$durationMs'}, count:{$sum:1}, errors:{$sum:{$cond:[{$eq:['$status','error']},1,0]}}}},
    ]),
  ]);
  const summary = agg[0]||{avgMs:0,maxMs:0,minMs:0,count:0,errors:0};
  return new ApiResponse(200, { items, total, limit, offset, summary: { count:summary.count, avgMs: summary.avgMs? Math.round(summary.avgMs*10)/10:0, maxMs:summary.maxMs, minMs:summary.minMs, errors:summary.errors } }).send(res);
});

module.exports={ listSearches, getSearchDetail, listExternalLogs };
