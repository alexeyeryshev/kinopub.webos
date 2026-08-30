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

`yarn deploy` installs the app onto a TV over the network - the scripted equivalent of dropping an
`.ipk` onto webOS Dev Manager.

```bash
yarn build && yarn package && yarn deploy
```

Or install a published release without building anything:

```bash
yarn deploy --release
```

| Flag                  | Description                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `--target <id>`       | Variant to install: `rakuten` (alias for `ui30`), `netflix`, `amazon`, `ivi`, `youtube`. Defaults to the main app id |
| `--release [tag]`     | Install a published release instead of a local build. Without a tag, the latest one                                  |
| `--repo <owner/name>` | Repository to take releases from. Defaults to the remote of the current branch                                       |
| `--device <name>`     | TV to install on. Defaults to the device marked as default                                                           |
| `--launch`            | Launch the app on the TV after installing                                                                            |

`--target rakuten` builds and installs under the `ui30` app id, which is Rakuten TV - installing over
it binds the app to the Rakuten button on the remote.

Without `--release`, the `.ipk` is chosen by the version in `package.json`, so run `yarn package`
again after bumping it.

Installing uses `@webos-tools/cli` (LG's TV CLI) rather than the `@webosose/ares-cli` that builds the
package. The OSE build expects a different permission layout and fails on a retail TV with
`rm: can't remove '/media/developer/temp': Permission denied`. Both packages install identically
named `ares-*` binaries, so the script calls the TV CLI by full path.

#### One-time TV setup

Enable Developer Mode on the TV along with its key server, then register the TV once:

```bash
npx ares-setup-device --add tv --info "{'host':'<TV IP>','port':'9922','username':'prisoner'}"
```

```bash
npx ares-novacom --device tv --getkey
```

The second command asks for the passphrase shown in the Developer Mode app. The app has to stay open
while you install - the session expires after about 50 hours, and once it does the TV still answers
ping but refuses port 9922.

List registered devices with `npx ares-setup-device --listfull`; plain `--list` prints an empty table
in this version of the CLI even when devices exist. Set the TV as the default target with
`npx ares-setup-device --default <name>`, otherwise installs go to the emulator.

## Screenshots

Checkout [screenshots here](./SCREENSHOTS.md)
