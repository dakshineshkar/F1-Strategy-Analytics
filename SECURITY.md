# Security

## Reporting a vulnerability

Please report security problems privately to the maintainers. Open a private security advisory on GitHub (the
repository's **Security** tab, then **Report a vulnerability**). Do not open a public issue or pull request for
it. Include what you found, how to reproduce it and the commit you tested.

## Supported versions

Only the latest release on `main` receives fixes. See [CHANGELOG.md](CHANGELOG.md).

## How the project handles secrets and network access

- **Secrets live only in `.env`.** The file is gitignored and never committed. `.env.example` is the committed
  template, with no real values. The F1 TV login for FastF1, if you use one, also belongs in `.env`.
- **The API and the dashboard bind to 127.0.0.1 only.** Docker publishes the API on `127.0.0.1:8000` and the
  dashboard on `127.0.0.1:3000`, so other machines cannot reach them.
- **The other services are published on every host interface by default:** Kafka (9092), Redis (6379), the HDFS
  web UIs (9870, 14000) and the Spark web UIs (8080 to 8082). Kafka and Redis run without authentication. Run
  the stack on a trusted machine or network, or block these ports with a firewall.
- The project is built for local academic use. It is not hardened for deployment on a public server.
