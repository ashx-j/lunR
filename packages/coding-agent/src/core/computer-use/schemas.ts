import { Type } from "@sinclair/typebox";

const target = {
	pid: Type.Integer({ minimum: 1 }),
	window_id: Type.Integer({ minimum: 1 }),
};
const grounded = {
	pid: Type.Optional(target.pid),
	window_id: Type.Optional(target.window_id),
	desktop: Type.Optional(
		Type.Boolean({
			description:
				"Use the primary desktop from a fresh desktop observation, with no pid/window_id. Requires foreground=true. Prefer window accessibility/background input when available.",
		}),
	),
	observation: Type.String({
		description: "Observation token from the latest computer_observe for this exact window or primary desktop.",
	}),
	foreground: Type.Optional(
		Type.Boolean({
			description:
				"Explicit focus escalation, only after background failure and fresh verification. Settings may forbid it.",
		}),
	),
};
const coordinate = Type.Number({ minimum: 0 });
const elementOrPixels = {
	element_index: Type.Optional(Type.Integer({ minimum: 0 })),
	x: Type.Optional(coordinate),
	y: Type.Optional(coordinate),
};
export const computerSchemas = {
	computer_load: Type.Object({}, { additionalProperties: false }),
	computer_apps: Type.Object({ pid: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false }),
	computer_observe: Type.Object(
		{
			pid: Type.Optional(target.pid),
			window_id: Type.Optional(target.window_id),
			desktop: Type.Optional(
				Type.Boolean({
					description:
						"Observe the primary desktop image instead of a window. Desktop input requires foreground control.",
				}),
			),
			screenshot: Type.Optional(Type.Boolean()),
		},
		{ additionalProperties: false },
	),
	computer_click: Type.Object(
		{
			...grounded,
			...elementOrPixels,
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
			...elementOrPixels,
			key: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
			keys: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 2, maxItems: 5 })),
		},
		{ additionalProperties: false },
	),
	computer_text: Type.Object(
		{ ...grounded, ...elementOrPixels, text: Type.String({ maxLength: 20000 }) },
		{ additionalProperties: false },
	),
	computer_window: Type.Object(
		{
			...target,
			observation: grounded.observation,
			action: Type.Optional(
				Type.Union([
					Type.Literal("frame"),
					Type.Literal("focus"),
					Type.Literal("minimize"),
					Type.Literal("restore"),
				]),
			),
			element_index: Type.Optional(
				Type.Integer({
					minimum: 0,
					description:
						"For minimize/restore, the observed accessibility index of that window control. The pinned driver has no portable minimize/restore RPC.",
				}),
			),
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
			x: Type.Optional(coordinate),
			y: Type.Optional(coordinate),
			direction: Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")]),
			amount: Type.Integer({ minimum: 1, maximum: 50 }),
			by: Type.Union([Type.Literal("line"), Type.Literal("page")]),
		},
		{ additionalProperties: false },
	),
	computer_end: Type.Object({}, { additionalProperties: false }),
};
