import { afterEach, expect, it, vi } from 'vitest';
import { Router } from 'express';
import { mountResearchRoutes } from './researchRoutes';
import * as vector from '../research/VectorBTService';

afterEach(() => vi.restoreAllMocks());

it.each([false, true])('settles a late VectorBT result without writing after a server timeout (reject=%s)', async (reject) => {
  const router = Router();
  mountResearchRoutes(router);
  const res: any = { headersSent: false, destroyed: false, json: vi.fn() };
  vi.spyOn(vector, 'getVectorBTStatus').mockImplementationOnce(async () => {
    res.headersSent = true;
    if (reject) throw new Error('late failure');
    return {} as any;
  });
  const next = vi.fn();
  const layer: any = router.stack.find((x: any) => x.route?.path === '/research/vectorbt/status');
  await layer.route.stack[0].handle({}, res, next);
  expect(res.json).not.toHaveBeenCalled();
  expect(next).not.toHaveBeenCalled();
});

it('forwards a timely failure to Express instead of leaking an unhandled rejection', async () => {
  const router = Router();
  mountResearchRoutes(router);
  const error = new Error('provider unavailable');
  vi.spyOn(vector, 'getVectorBTStatus').mockRejectedValueOnce(error);
  const res: any = { headersSent: false, destroyed: false, json: vi.fn() };
  const next = vi.fn();
  const layer: any = router.stack.find((x: any) => x.route?.path === '/research/vectorbt/status');
  await layer.route.stack[0].handle({}, res, next);
  expect(next).toHaveBeenCalledWith(error);
  expect(res.json).not.toHaveBeenCalled();
});
