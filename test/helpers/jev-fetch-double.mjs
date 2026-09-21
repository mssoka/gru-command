#!/usr/bin/env node
/* global Headers, Response */
/** Offline global-fetch double injected into compiled-service child processes
 * with NODE_OPTIONS=--import. It never records Authorization bytes. */
import { appendFileSync, readFileSync } from 'node:fs';
import process from 'node:process';

function answerEnvelope(body) {
  const request = JSON.parse(body);
  const answers = {};
  for (const [id, question] of Object.entries(request.questions ?? {})) {
    if (question.type === 'noul') answers[id] = { type: 'noul', noul: 0.96 };
    if (question.type === 'choice') {
      const options = question.options ?? [];
      answers[id] = {
        type: 'choice',
        choice: options[0],
        probabilities: Object.fromEntries(options.map((option, index) => [option, index === 0 ? 1 : 0])),
        confidence: 0.96,
      };
    }
    if (question.type === 'score') {
      const criteria = question.criteria ?? [];
      answers[id] = {
        type: 'score',
        score: 0,
        legend: Object.fromEntries(criteria.map((value, index) => [String(index), value])),
        probabilities: Object.fromEntries(criteria.map((_value, index) => [String(index), index === 0 ? 1 : 0])),
        confidence: 0.96,
      };
    }
  }
  return { model: 'typesafe/jev-offline-double', answers, usage: { input_tokens: 1, output_tokens: 1, cost: 0 } };
}

globalThis.fetch = async (url, init = {}) => {
  const headers = new Headers(init.headers);
  const body = String(init.body ?? '');
  const logFile = process.env.JEV_FETCH_LOG;
  if (logFile) {
    appendFileSync(logFile, `${JSON.stringify({
      url: String(url),
      authorizationPresent: headers.has('authorization'),
      ambientKeyPresent: typeof process.env.OPENROUTER_API_KEY === 'string',
      questionIds: Object.keys(JSON.parse(body).questions ?? {}),
    })}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  let mode = process.env.JEV_FETCH_MODE;
  if (process.env.JEV_FETCH_MODE_FILE) {
    try { mode = readFileSync(process.env.JEV_FETCH_MODE_FILE, 'utf8').trim(); } catch { /* default success */ }
  }
  if (mode === 'network-error') throw new TypeError('offline fetch double network error');
  return new Response(JSON.stringify(answerEnvelope(body)), { status: 200, headers: { 'content-type': 'application/json' } });
};
