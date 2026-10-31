import { Router } from 'express';

export const healthRouter = Router();

/** Liveness check. Reveals nothing about configuration or secrets. */
healthRouter.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'vaharo-api', time: new Date().toISOString() });
});
