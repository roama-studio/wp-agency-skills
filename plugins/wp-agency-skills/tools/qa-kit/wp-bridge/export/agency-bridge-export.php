<?php
/**
 * Plugin Name:       Агенція: експорт
 * Description:       Робить архів сайту (файли + база) для агенції, щоб правки робились на копії, а не на живому сайті. Архів закритий від інтернету і видаляється після завантаження або через 24 години. Після роботи плагін можна видалити.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Agency
 * License:           GPL-2.0-or-later
 * Text Domain:       agency-bridge-export
 *
 * the export bridge for partner sites reached only through wp-admin. The
 * archive is the shape `qa-kit wp-site import` takes: files/ + database.sql.
 *
 * @package AgencyBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

require_once __DIR__ . '/includes/class-agency-bridge-export.php';

const AGENCY_BRIDGE_EXPORT_PAGE = 'agency-bridge-export';

/** Who may export: site admins; on a multisite network only super admins (the dump holds every site). */
function agency_bridge_export_allowed() {
	return is_multisite() ? is_super_admin() : current_user_can( 'manage_options' );
}

register_deactivation_hook(
	__FILE__,
	function () {
		Agency_Bridge_Export::cleanup();
		wp_clear_scheduled_hook( 'agency_bridge_export_cleanup' );
	}
);

add_action( 'agency_bridge_export_cleanup', array( 'Agency_Bridge_Export', 'expire' ) );
add_action( 'admin_init', array( 'Agency_Bridge_Export', 'expire' ) );

add_action(
	'admin_menu',
	function () {
		if ( ! agency_bridge_export_allowed() ) {
			return;
		}
		add_management_page( 'Агенція: експорт', 'Агенція: експорт', 'manage_options', AGENCY_BRIDGE_EXPORT_PAGE, 'agency_bridge_export_page' );
	}
);

/** AJAX: start / step / status. Every call: admin + nonce. */
add_action(
	'wp_ajax_agency_bridge_export',
	function () {
		if ( ! agency_bridge_export_allowed() ) {
			wp_send_json_error( array( 'message' => 'Недостатньо прав.' ), 403 );
		}
		check_ajax_referer( 'agency_bridge_export' );
		$do = isset( $_POST['do'] ) ? sanitize_key( wp_unslash( $_POST['do'] ) ) : 'status';
		try {
			if ( 'start' === $do ) {
				wp_send_json_success( Agency_Bridge_Export::start() );
			} elseif ( 'step' === $do ) {
				wp_send_json_success( Agency_Bridge_Export::step() );
			} elseif ( 'cancel' === $do ) {
				Agency_Bridge_Export::cleanup();
				wp_send_json_success( array( 'phase' => 'none' ) );
			}
			wp_send_json_success( Agency_Bridge_Export::progress( Agency_Bridge_Export::job() ) );
		} catch ( Exception $e ) {
			wp_send_json_error( array( 'message' => $e->getMessage() ), 500 );
		}
	}
);

/** The archive: admin + nonce, streamed by PHP (the folder itself is closed to the web). */
add_action(
	'admin_post_agency_bridge_export_download',
	function () {
		if ( ! agency_bridge_export_allowed() ) {
			wp_die( esc_html( 'Недостатньо прав.' ), 403 );
		}
		check_admin_referer( 'agency_bridge_export_download' );
		try {
			Agency_Bridge_Export::download();
		} catch ( Exception $e ) {
			wp_die( esc_html( $e->getMessage() ), 404 );
		}
		exit;
	}
);

/** Removes the job, deactivates and deletes this plugin. */
add_action(
	'admin_post_agency_bridge_export_remove',
	function () {
		if ( ! agency_bridge_export_allowed() ) {
			wp_die( esc_html( 'Недостатньо прав.' ), 403 );
		}
		check_admin_referer( 'agency_bridge_export_remove' );
		Agency_Bridge_Export::cleanup();
		wp_clear_scheduled_hook( 'agency_bridge_export_cleanup' );
		$plugin = plugin_basename( __FILE__ );
		deactivate_plugins( $plugin );
		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/plugin.php';
		$deleted = delete_plugins( array( $plugin ) );
		wp_safe_redirect( add_query_arg( 'agency-bridge', true === $deleted ? 'removed' : 'deactivated', admin_url( 'plugins.php' ) ) );
		exit;
	}
);

add_action(
	'admin_notices',
	function () {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- only picks a notice text.
		$flag = isset( $_GET['agency-bridge'] ) ? sanitize_key( wp_unslash( $_GET['agency-bridge'] ) ) : '';
		if ( 'deactivated' === $flag ) {
			echo '<div class="notice notice-warning"><p>' . esc_html( 'Плагін «Агенція: експорт» вимкнено, архів видалено. Видаліть плагін тут, у списку плагінів.' ) . '</p></div>';
		} elseif ( 'removed' === $flag ) {
			echo '<div class="notice notice-success"><p>' . esc_html( 'Плагін «Агенція: експорт» і архів видалено.' ) . '</p></div>';
		}
	}
);

function agency_bridge_export_page() {
	if ( ! agency_bridge_export_allowed() ) {
		wp_die( esc_html( 'Недостатньо прав.' ), 403 );
	}
	$progress = Agency_Bridge_Export::progress( Agency_Bridge_Export::job() );
	$download = wp_nonce_url( admin_url( 'admin-post.php?action=agency_bridge_export_download' ), 'agency_bridge_export_download' );
	$config   = array(
		'ajax'     => admin_url( 'admin-ajax.php' ),
		'nonce'    => wp_create_nonce( 'agency_bridge_export' ),
		'download' => $download,
		'progress' => $progress,
	);
	?>
	<div class="wrap" id="agency-bridge-export">
		<h1><?php echo esc_html( 'Агенція: експорт' ); ?></h1>
		<p><?php echo esc_html( 'Плагін робить архів сайту: усі файли WordPress (без wp-config.php з паролями, кешу, бекапів та архівів) і копію бази даних. Агенція робить правки на копії, а не на живому сайті.' ); ?></p>
		<p><?php echo esc_html( 'Архів лежить у закритій папці, завантажити його може лише адміністратор. Після завантаження архів видаляється, незавантажений — через 24 години.' ); ?></p>
		<p>
			<button type="button" class="button button-primary" data-do="start"><?php echo esc_html( 'Почати експорт' ); ?></button>
			<a class="button button-primary" data-role="download" href="<?php echo esc_url( $download ); ?>" style="display:none"><?php echo esc_html( 'Завантажити архів' ); ?></a>
			<button type="button" class="button" data-do="cancel" style="display:none"><?php echo esc_html( 'Скасувати і видалити архів' ); ?></button>
		</p>
		<div data-role="bar" style="max-width:600px;height:18px;background:#dcdcde;border-radius:3px;overflow:hidden;display:none"><div style="height:100%;width:0;background:#2271b1;transition:width .3s"></div></div>
		<p data-role="text" aria-live="polite"></p>
		<hr>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" onsubmit="return confirm(<?php echo esc_attr( wp_json_encode( 'Видалити плагін «Агенція: експорт» разом з архівом?' ) ); ?>)">
			<?php wp_nonce_field( 'agency_bridge_export_remove' ); ?>
			<input type="hidden" name="action" value="agency_bridge_export_remove">
			<button type="submit" class="button"><?php echo esc_html( 'Видалити плагін' ); ?></button>
		</form>
	</div>
	<script>
	( function () {
		var cfg = <?php echo wp_json_encode( $config ); ?>;
		var root = document.getElementById( 'agency-bridge-export' );
		var startBtn = root.querySelector( '[data-do="start"]' );
		var cancelBtn = root.querySelector( '[data-do="cancel"]' );
		var download = root.querySelector( '[data-role="download"]' );
		var bar = root.querySelector( '[data-role="bar"]' );
		var text = root.querySelector( '[data-role="text"]' );
		var busy = false;

		function show( p ) {
			var running = p.phase && p.phase !== 'none' && p.phase !== 'done';
			bar.style.display = p.phase && p.phase !== 'none' ? 'block' : 'none';
			bar.firstChild.style.width = ( p.percent || 0 ) + '%';
			text.textContent = p.phase === 'none' ? '' : ( p.text || '' ) + ( p.phase !== 'done' && p.bytes ? ' · архів зараз ' + p.size : '' )
				+ ( p.skipped ? ' · пропущено (кеш, бекапи, архіви): ' + p.skipped : '' );
			startBtn.style.display = running ? 'none' : '';
			startBtn.textContent = p.phase === 'done' ? 'Зробити експорт заново' : 'Почати експорт';
			cancelBtn.style.display = p.phase && p.phase !== 'none' ? '' : 'none';
			download.style.display = p.phase === 'done' ? '' : 'none';
			return running;
		}

		function call( what ) {
			var body = new FormData();
			body.append( 'action', 'agency_bridge_export' );
			body.append( '_ajax_nonce', cfg.nonce );
			body.append( 'do', what );
			return fetch( cfg.ajax, { method: 'POST', body: body, credentials: 'same-origin' } ).then( function ( r ) {
				return r.json().catch( function () {
					throw new Error( 'сервер відповів помилкою ' + r.status + ' (ліміт часу або пам’яті хостингу?)' );
				} );
			} ).then( function ( j ) {
				if ( ! j.success ) {
					throw new Error( j.data && j.data.message ? j.data.message : 'помилка' );
				}
				return j.data;
			} );
		}

		function run( first ) {
			if ( busy ) {
				return;
			}
			busy = true;
			var loop = function ( what, tries ) {
				call( what ).then( function ( p ) {
					tries = 0;
					if ( show( p ) ) {
						loop( 'step', 0 );
					} else {
						busy = false;
					}
				} ).catch( function ( e ) {
					// A step can hit the host's limit: retry a few times, it resumes where it stopped.
					if ( what === 'step' && tries < 3 ) {
						setTimeout( function () { loop( 'step', tries + 1 ); }, 2000 );
						return;
					}
					busy = false;
					text.textContent = 'Помилка: ' + e.message;
					startBtn.style.display = '';
				} );
			};
			loop( first, 0 );
		}

		startBtn.addEventListener( 'click', function () { run( 'start' ); } );
		cancelBtn.addEventListener( 'click', function () {
			call( 'cancel' ).then( show );
		} );
		download.addEventListener( 'click', function () {
			setTimeout( function () { text.textContent = 'Архів завантажується. Після завантаження він видаляється з сайту.'; download.style.display = 'none'; }, 500 );
		} );
		if ( show( cfg.progress ) ) {
			run( 'step' );
		}
	}() );
	</script>
	<?php
}
