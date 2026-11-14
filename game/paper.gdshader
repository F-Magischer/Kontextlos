shader_type canvas_item;
// Printed-paper background: warm stock, faint jittered halftone, a little grain.
uniform vec4 paper : source_color = vec4(0.937, 0.906, 0.839, 1.0);
uniform vec4 ink : source_color = vec4(0.106, 0.102, 0.090, 1.0);
uniform float cell = 9.0;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void fragment() {
	vec2 p = FRAGCOORD.xy / cell;
	float d = length(fract(p) - 0.5);
	float r = 0.11 + 0.04 * hash(floor(p));
	float dots = 1.0 - smoothstep(r, r + 0.07, d);
	float grain = hash(FRAGCOORD.xy) * 0.035;
	COLOR = mix(paper, ink, dots * 0.11 + grain);
}
