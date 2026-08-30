# Kinopub WebOS

A Kinopub client for LG Smart TVs with WebOS - using EnactJS, Moonstone

## Requirements

- LG Smart TV with WebOS v3+
- [WebOS CLI](https://webostv.developer.lge.com/sdk/installation/)

or

- Smart TV with Media Station X

## Installation

[Follow this instruction](https://webostv.developer.lge.com/develop/app-test) to prepare your LG Smart TV  
[Следуйте этой инструкции](https://bit.ly/3uyLWkl) чтобы подготовить ваш LG Smart TV

- Download [latest ipk file](https://github.com/adascal/kinopub.webos/releases/latest)
- `$ ares-install --device $DEVICE_NAME $PATH_TO_IPK_FILE`

[Следуйте этой инструкции](https://bit.ly/3s4YoYg) чтобы установить через Media Station X

## Development

```bash
yarn install
yarn start
```

`.nvmrc` pins Node 14 (`lts/fermium`). On newer Node the build fails with `ERR_OSSL_EVP_UNSUPPORTED`
(webpack 4 against OpenSSL 3) and, on Node 18+, with a `lib/mappings.wasm` error from the source-map
package. Either use the pinned version, or prefix the commands:

```bash
GENERATE_SOURCEMAP=false NODE_OPTIONS=--openssl-legacy-provider yarn build
```

### Installing on a TV

`yarn deploy` installs the packaged app onto a TV over the network — the scripted equivalent of
dropping an `.ipk` onto webOS Dev Manager. It uses the `@webosose/ares-cli` that already ships with
the project, so no separate SDK installation is needed.

```bash
yarn build && yarn package && yarn deploy
```

| Flag              | Description                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `--target <id>`   | Variant to install: `netflix`, `amazon`, `ivi`, `youtube`, `ui30`. Defaults to the main app id |
| `--device <name>` | TV to install on. Defaults to the device marked as default                                     |
| `--launch`        | Launch the app on the TV after installing                                                      |

The `.ipk` is chosen by the version in `package.json`, so run `yarn package` again after bumping it.

#### One-time TV setup

Enable Developer Mode on the TV, then register it once:

```bash
npx ares-setup-device --add tv --info "{'host':'<TV IP>','port':'9922','username':'prisoner','privatekey':'<key file in ~/.ssh>','passphrase':'<passphrase>'}"
```

The Developer Mode app on the TV shows the IP and the passphrase. It has to stay open while you
install — the session expires after about 50 hours, and once it does the TV still answers ping but
refuses port 9922.

List registered devices with `npx ares-setup-device --listfull`; plain `--list` prints an empty table
in this version of the CLI even when devices exist.

## Screenshots

Checkout [screenshots here](./SCREENSHOTS.md)
