import type { AxisLimit, RobotSpecInput } from '../src/index.ts';

// Fichas de prueba con datos tomados de los datasheets del catálogo.

export const deg = (axis: number, min: number, max: number, speed = 200): AxisLimit => ({
  axis,
  min,
  max,
  unit: 'deg',
  max_speed: speed,
  speed_unit: 'deg/s',
});

export const IRB1300: RobotSpecInput = {
  kinematic_type: 'serial',
  axes_count: 6,
  reach_mm: 1400,
  workspace_diameter_mm: null,
  payload_kg: 7,
  axis_limits: [
    deg(1, -180, 180, 280),
    deg(2, -95, 155, 228),
    deg(3, -210, 69, 336),
    deg(4, -230, 230, 500),
    deg(5, -130, 130, 415),
    deg(6, -400, 400, 720),
  ],
};

export const IRB460: RobotSpecInput = {
  kinematic_type: null,
  axes_count: 4,
  reach_mm: 2400,
  workspace_diameter_mm: null,
  payload_kg: 110,
  axis_limits: [deg(1, -165, 165, 145), deg(2, -40, 85, 110), deg(3, -20, 120, 120)],
};

export const IRB360: RobotSpecInput = {
  kinematic_type: 'delta',
  axes_count: null,
  reach_mm: null,
  workspace_diameter_mm: 1130,
  payload_kg: 1,
  axis_limits: null,
};

export const IRB910: RobotSpecInput = {
  kinematic_type: 'scara',
  axes_count: 4,
  reach_mm: 350,
  workspace_diameter_mm: null,
  payload_kg: 3,
  axis_limits: [
    deg(1, -225, 225, 672),
    deg(2, -225, 225, 748),
    { axis: 3, min: -140, max: 0, unit: 'mm', max_speed: 1.1, speed_unit: 'm/s' },
    deg(4, -720, 720, 3000),
  ],
};
