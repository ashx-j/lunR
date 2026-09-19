import { Type } from "@sinclair/typebox";

const target = {
	pid: Type.Integer({ minimum: 1 }),
	window_id: Type.Integer({ minimum: 1 }),
};
const observation = Type.String({
	description: "Latest image token for this exact target. Single action, expires after 30 seconds.",
});
const grounded = {
	pid: Type.Optional(target.pid),
	window_id: Type.Optional(target.window_id),
	desktop: Type.Optional(Type.Boolean({ description: "Primary desktop instead of a window; requires foreground=true." })),
	observation,
	foreground: Type.Optional(Type.Boolean({ description: "Window focus escalation after verified background failure. Settings may forbid it." })),
};
const coordinate = Type.Number({ minimum: 0 });
const pixels = { x: coordinate, y: coordinate };
const optionalPixels = { x: Type.Optional(coordinate), y: Type.Optional(coordinate) };
export const computerSchemas = {
	computer_load: Type.Object({}, { additionalProperties: false }),
	computer_apps: Type.Object({ pid: Type.Optional(target.pid) }, { additionalProperties: false }),
	computer_observe: Type.Object(
		{
			pid: Type.Optional(target.pid),
			window_id: Type.Optional(target.window_id),
			desktop: Type.Optional(Type.Boolean({ description: "Capture the primary desktop instead of a window." })),
			observation: Type.Optional(observation),
			crop: Type.Optional(Type.Object({
				x: coordinate,
				y: coordinate,
				width: Type.Number({ exclusiveMinimum: 0 }),
				height: Type.Number({ exclusiveMinimum: 0 }),
			}, { additionalProperties: false, description: "Region in the latest returned image's pixels; requires its observation token. Captures fresh pixels. Omit for full target." })),
		},
		{ additionalProperties: false },
	),
	computer_click: Type.Object(
		{
			...grounded,
			...pixels,
			button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right")])),
			count: Type.Optional(Type.Integer({ minimum: 1, maximum: 2 })),
			modifier: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 4 })),
		},
		{ additionalProperties: false },
	),
	computer_drag: Type.Object(
		{ ...grounded, from_x: coordinate, from_y: coordinate, to_x: coordinate, to_y: coordinate },
		{ additionalProperties: false },
	),
	computer_key: Type.Object(
		{
			...grounded,
			...optionalPixels,
			key: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
			keys: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 2, maxItems: 5 })),
		},
		{ additionalProperties: false },
	),
	computer_text: Type.Object(
		{ ...grounded, ...optionalPixels, text: Type.String({ maxLength: 20000 }) },
		{ additionalProperties: false },
	),
	computer_window: Type.Object(
		{
			...target,
			observation,
			action: Type.Union([Type.Literal("frame"), Type.Literal("focus")]),
			x: Type.Optional(Type.Number()),
			y: Type.Optional(Type.Number()),
			width: Type.Optional(Type.Integer({ minimum: 1 })),
			height: Type.Optional(Type.Integer({ minimum: 1 })),
		},
		{ additionalProperties: false },
	),
	computer_launch: Type.Object(
		{ name: Type.String({ minLength: 1, maxLength: 500 }) },
		{ additionalProperties: false },
	),
	computer_scroll: Type.Object(
		{
			...grounded,
			...pixels,
			direction: Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")]),
			amount: Type.Integer({ minimum: 1, maximum: 50 }),
			by: Type.Union([Type.Literal("line"), Type.Literal("page")]),
		},
		{ additionalProperties: false },
	),
	computer_end: Type.Object({}, { additionalProperties: false }),
};
