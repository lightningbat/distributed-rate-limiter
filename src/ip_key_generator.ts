import { isIPv6 } from 'node:net';
import { Address6 } from 'ip-address';

/**
 * IP Key Generator from express-rate-limit source core.
 * Normalizes IPv4-mapped forms and groups volatile IPv6 allocations into subnets.
 */
export function ipKeyGenerator(ip: string, ipv6Subnet: number | false = 56): string {
	// If Express fails to parse an IP or trust proxy settings are misconfigured, fall back early
	if (!ip) return 'unknown-client-ip';

	if (isIPv6(ip)) {
		try {
			const address = new Address6(ip);

			// Extract raw IPv4 if it's wrapped in dual-stack notation (::ffff:192.168.1.1)
			if (address.is4()) {
				return address.to4().correctForm();
			}

			// Group the client into their broader neighborhood block to eliminate IP-cycling attacks
			if (ipv6Subnet) {
				const subnet = new Address6(`${ip}/${ipv6Subnet}`);
				return subnet.networkForm();
			}
		} catch {
			// If the IP string is distorted or parsing errors out, fall back safely to the raw input
			return ip;
		}
	}

	return ip;
}
