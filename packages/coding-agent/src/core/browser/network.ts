import { lookup } from "node:dns/promises";
import { createServer, type OutgoingHttpHeaders, request } from "node:http";
import { BlockList, connect, isIP, type Socket } from "node:net";

const blocked = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["192.88.99.0", 24],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const)
	blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["3fff::", 20],
] as const)
	blocked.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export function isPublicAddress(address: string): boolean {
	if (isIP(address) === 4) return !blocked.check(address, "ipv4");
	return isIP(address) === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export function browserUrl(raw: string): URL {
	const url = new URL(raw);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
		throw new Error("Browser permits HTTP(S) URLs without embedded credentials only.");
	}
	return url;
}

export async function resolveBrowserHost(host: string, allowPrivate: boolean): Promise<string> {
	const hostname = host.replace(/^\[|\]$/g, "");
	const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
	if (!addresses.length || (!allowPrivate && addresses.some(({ address }) => !isPublicAddress(address)))) {
		throw new Error(
			"Browser network policy blocked a private or reserved address. Local/private access requires explicit user configuration.",
		);
	}
	return addresses[0].address;
}

export async function createBrowserProxy(allowPrivate: boolean) {
	const sockets = new Set<Socket>();
	let closed = false;
	let lastBlocked: string | undefined;
	const track = (socket: Socket) => {
		if (closed || sockets.size >= 128) {
			socket.destroy();
			return;
		}
		sockets.add(socket);
		socket.setTimeout(30000, () => socket.destroy());
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => socket.destroy());
	};
	const server = createServer(async (incoming, outgoing) => {
		try {
			const url = browserUrl(incoming.url ?? "");
			if (url.protocol !== "http:") throw new Error("Use CONNECT for HTTPS.");
			const address = await resolveBrowserHost(url.hostname, allowPrivate);
			if (closed || incoming.destroyed) return outgoing.destroy();
			const headers: OutgoingHttpHeaders = { ...incoming.headers, host: url.host };
			delete headers["proxy-authorization"];
			delete headers["proxy-connection"];
			const upstream = request(
				{
					hostname: address,
					port: url.port || 80,
					method: incoming.method,
					path: `${url.pathname}${url.search}`,
					headers,
					agent: false,
				},
				(response) => {
					outgoing.writeHead(response.statusCode ?? 502, response.headers);
					response.pipe(outgoing);
				},
			);
			upstream.on("socket", track);
			upstream.on("error", () => outgoing.destroy());
			outgoing.on("close", () => upstream.destroy());
			incoming.pipe(upstream);
		} catch (error) {
			lastBlocked = error instanceof Error ? error.message : "Network request blocked.";
			outgoing.writeHead(403).end("Browser network policy blocked this request.");
		}
	});
	server.on("connection", track);
	server.on("connect", async (incoming, client, head) => {
		try {
			const url = browserUrl(`https://${incoming.url}`);
			const address = await resolveBrowserHost(url.hostname, allowPrivate);
			if (closed || client.destroyed) return client.destroy();
			// Connect to the checked IP, not the hostname, so DNS rebinding cannot change the destination.
			const upstream = connect({ host: address, port: Number(url.port || 443) });
			track(upstream);
			client.on("close", () => upstream.destroy());
			upstream.on("close", () => client.destroy());
			upstream.on("connect", () => {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (head.length) upstream.write(head);
				client.pipe(upstream);
				upstream.pipe(client);
			});
		} catch (error) {
			lastBlocked = error instanceof Error ? error.message : "Network request blocked.";
			client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
		}
	});
	server.on("upgrade", (_request, socket) => socket.destroy());
	server.on("clientError", (_error, socket) => socket.destroy());
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Browser proxy failed to listen.");
	return {
		url: `http://127.0.0.1:${address.port}`,
		blockedReason: () => lastBlocked,
		async close() {
			closed = true;
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
