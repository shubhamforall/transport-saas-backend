import { Router } from 'express';
import { requirePermission } from '../../middleware/tenant.js';
import { enforcePlanLimit } from '../../services/plan-limits.js';
import { idParam, tenantOf, userOf } from '../../utils/params.js';
import { createVehicleSchema, updateVehicleSchema, vehicleListSchema } from './vehicles.schemas.js';
import {
  createVehicle,
  getVehicle,
  listVehicles,
  setVehicleStatus,
  updateVehicle,
} from './vehicles.service.js';

/** Mounted under /tenants/:tenantId/vehicles after requireTenantMember. */
export const vehiclesRouter = Router({ mergeParams: true });

vehiclesRouter.get('/', requirePermission('vehicles.read'), async (req, res) => {
  res.json(await listVehicles(tenantOf(req), vehicleListSchema.parse(req.query)));
});

vehiclesRouter.post('/', requirePermission('vehicles.write'), async (req, res) => {
  const input = createVehicleSchema.parse(req.body);
  const tenantId = tenantOf(req);
  const vehicle = await createVehicle(tenantId, userOf(req), input, req, (tx) =>
    enforcePlanLimit(tx, tenantId, 'maxVehicles'),
  );
  res.status(201).json(vehicle);
});

vehiclesRouter.get('/:vehicleId', requirePermission('vehicles.read'), async (req, res) => {
  res.json(await getVehicle(tenantOf(req), idParam(req, 'vehicleId', 'Vehicle')));
});

vehiclesRouter.patch('/:vehicleId', requirePermission('vehicles.write'), async (req, res) => {
  const input = updateVehicleSchema.parse(req.body);
  const id = idParam(req, 'vehicleId', 'Vehicle');
  res.json(await updateVehicle(tenantOf(req), userOf(req), id, input, req));
});

vehiclesRouter.post(
  '/:vehicleId/deactivate',
  requirePermission('vehicles.write'),
  async (req, res) => {
    const id = idParam(req, 'vehicleId', 'Vehicle');
    res.json(await setVehicleStatus(tenantOf(req), userOf(req), id, 'INACTIVE', req));
  },
);

vehiclesRouter.post(
  '/:vehicleId/activate',
  requirePermission('vehicles.write'),
  async (req, res) => {
    const id = idParam(req, 'vehicleId', 'Vehicle');
    res.json(await setVehicleStatus(tenantOf(req), userOf(req), id, 'ACTIVE', req));
  },
);
