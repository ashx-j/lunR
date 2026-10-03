/**
 * Remove terminal instructions from untrusted display source before applying styles.
 * Stored messages and explicit clipboard payloads must retain their original source.
 * This is not for rendered output, which can contain trusted links and image protocols.
 */
export function sanitizeTerminalText(source: string): string {
	if (!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(source)) return source;

	const parts: string[] = [];
	let index = 0;
	let plainStart = 0;
	while (index < source.length) {
		const code = source.charCodeAt(index);
		if (code === 9 || code === 10 || (code >= 32 && (code < 127 || code > 159))) {
			index++;
			continue;
		}
		parts.push(source.slice(plainStart, index));
		index++;
		if (code === 13) {
			// CR is a terminal cursor instruction. Preserve logical source line endings.
			if (source.charCodeAt(index) === 10) index++;
			parts.push("\n");
		} else {
			let sequence = code;
			if (code === 27 && index < source.length) {
				const next = source.charCodeAt(index);
				if (next >= 64 && next <= 95) {
					sequence = next + 64; // ESC form of a C1 control.
					index++;
				} else {
					// ESC intermediates and final byte, including charset selection and RIS.
					while (source.charCodeAt(index) >= 32 && source.charCodeAt(index) <= 47) index++;
					if (source.charCodeAt(index) >= 48 && source.charCodeAt(index) <= 126) index++;
				}
			}
			if (sequence === 155) {
				// CSI parameters, intermediates and final byte. Incomplete prefixes stay inert.
				while (source.charCodeAt(index) >= 32 && source.charCodeAt(index) <= 63) index++;
				if (source.charCodeAt(index) >= 64 && source.charCodeAt(index) <= 126) index++;
			} else if ([144, 152, 157, 158, 159].includes(sequence)) {
				// DCS, SOS, OSC, PM and APC are opaque strings, including split streaming prefixes.
				while (index < source.length) {
					const next = source.charCodeAt(index++);
					if (next === 156 || (sequence === 157 && next === 7)) break;
					if (next === 27 && source.charCodeAt(index) === 92) {
						index++;
						break;
					}
				}
			}
		}
		plainStart = index;
	}
	parts.push(source.slice(plainStart));
	return parts.join("");
}
