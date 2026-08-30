const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');

/**
 * Установка собранного пакета на телевизор — то же, что перетащить .ipk в webOS Dev Manager.
 *
 * Телевизор нужно один раз зарегистрировать (см. подсказку ниже): ares-cli держит свой список
 * устройств и список Dev Manager не видит.
 */

const APP_IDS = [pkg.name, 'netflix', 'amazon', 'ivi', 'youtube', 'ui30'];

const outDir = path.resolve(__dirname, '..', 'out');
const aresBin = (name) => path.resolve(__dirname, '..', 'node_modules', '.bin', name);

function parseArgs(argv) {
  const args = { target: pkg.name, device: null, launch: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--launch') {
      args.launch = true;
    } else if (arg === '--target' || arg === '-t') {
      args.target = argv[++i];
    } else if (arg === '--device' || arg === '-d') {
      args.device = argv[++i];
    } else {
      console.error(`Неизвестный аргумент: ${arg}`);
      process.exit(1);
    }
  }

  return args;
}

function run(bin, args) {
  return execFileSync(aresBin(bin), args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
}

// --list печатает пустую таблицу даже при наличии устройств, поэтому разбираем --listfull
function listDevices() {
  try {
    const devices = JSON.parse(run('ares-setup-device', ['--listfull']));

    return Array.isArray(devices) ? devices : [];
  } catch (ex) {
    return [];
  }
}

function main() {
  const { target, device, launch } = parseArgs(process.argv.slice(2));

  if (!APP_IDS.includes(target)) {
    console.error(`Неизвестный target «${target}». Доступные: ${APP_IDS.join(', ')}`);
    process.exit(1);
  }

  const suffix = target === pkg.name ? '' : `_${target}`;
  const ipk = path.resolve(outDir, `${pkg.name}_v${pkg.version}${suffix}.ipk`);

  if (!fs.existsSync(ipk)) {
    console.error(`Не найден ${path.relative(process.cwd(), ipk)}`);
    console.error('Сначала соберите пакет: yarn build && yarn package');
    process.exit(1);
  }

  const devices = listDevices();

  if (!devices.length) {
    console.error('Ни одного устройства не зарегистрировано в ares-cli.');
    console.error('Включите на телевизоре Developer Mode и выполните один раз:');
    console.error('');
    console.error(
      "  npx ares-setup-device --add tv --info \"{'host':'<IP телевизора>','port':'9922','username':'prisoner'," +
        "'privatekey':'<файл из ~/.ssh>','passphrase':'<passphrase из Developer Mode>'}\"",
    );
    console.error('');
    console.error('IP, passphrase и ключ показывает приложение Developer Mode на телевизоре.');
    process.exit(1);
  }

  const deviceArgs = device ? ['-d', device] : [];

  console.log(`Устанавливаю ${path.basename(ipk)}${device ? ` на ${device}` : ''}...`);
  process.stdout.write(run('ares-install', [...deviceArgs, ipk]));

  if (launch) {
    console.log(`Запускаю ${target}...`);
    process.stdout.write(run('ares-launch', [...deviceArgs, target]));
  }
}

try {
  main();
} catch (ex) {
  console.error(ex.stderr || ex.message);
  process.exit(1);
}
