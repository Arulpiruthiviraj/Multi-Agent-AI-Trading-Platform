package io.argus.quantcore.server;

/**
 * Standalone entry point: {@code java -jar quant-core-java.jar [port]}. Default port 8085,
 * matching the local IPC bridge contract's default in the migration blueprint. Binds to
 * 127.0.0.1 only (see QuantCoreServer's own header comment) — never reachable off this host.
 */
public final class Main {
    private Main() {
    }

    public static void main(String[] args) throws Exception {
        int port = args.length > 0 ? Integer.parseInt(args[0]) : 8085;
        QuantCoreServer server = new QuantCoreServer(port);
        server.start();
        System.out.println("Argus Quant Core listening on 127.0.0.1:" + port + " (advisory only, no broker access)");
        Runtime.getRuntime().addShutdownHook(new Thread(server::stop));
    }
}
