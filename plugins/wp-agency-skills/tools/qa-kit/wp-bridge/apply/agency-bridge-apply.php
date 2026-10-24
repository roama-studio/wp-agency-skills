<?php
/**
 * Plugin Name:       Агенція: правки
 * Description:       Застосовує підготовлений агенцією набір правок до сайту з перевіркою і кнопкою «Відкотити». Після роботи плагін можна видалити.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Agency
 * License:           GPL-2.0-or-later
 * Text Domain:       agency-bridge-apply
 *
 * the apply bridge for partner sites reached only through wp-admin. The
 * edit set is built per order by `qa-kit bridge build` and embedded in
 * edits/payload.php (PHP, so the web server never serves it as a file).
 *
 * @package AgencyBridge
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

require_once __DIR__ . '/includes/class-agency-bridge-edits.php';

const AGENCY_BRIDGE_APPLY_PAGE = 'agency-bridge-apply';

/** Who may use the bridge: site admins; on a multisite network only super admins. */
function agency_bridge_apply_allowed() {
	return is_multisite() ? is_super_admin() : current_user_can( 'manage_options' );
}

/** The embedded edit set (null + message when it is missing or broken). */
function agency_bridge_apply_set() {
	static $set = null;
	static $error = null;
	if ( null === $set && null === $error ) {
		try {
			$set = Agency_Bridge_Edits::load( __DIR__ . '/edits/payload.php' );
		} catch ( Exception $e ) {
			$error = $e->getMessage();
		}
	}
	return array( $set, $error );
}

add_action(
	'admin_menu',
	function () {
		if ( ! agency_bridge_apply_allowed() ) {
			return;
		}
		add_management_page( 'Агенція: правки', 'Агенція: правки', 'manage_options', AGENCY_BRIDGE_APPLY_PAGE, 'agency_bridge_apply_page' );
	}
);

add_action( 'admin_post_agency_bridge_apply', 'agency_bridge_apply_handle' );

function agency_bridge_apply_url( $args = array() ) {
	return add_query_arg( array_merge( array( 'page' => AGENCY_BRIDGE_APPLY_PAGE ), $args ), admin_url( 'tools.php' ) );
}

function agency_bridge_apply_handle() {
	if ( ! agency_bridge_apply_allowed() ) {
		wp_die( esc_html__( 'Недостатньо прав.', 'agency-bridge-apply' ), 403 );
	}
	check_admin_referer( 'agency_bridge_apply' );
	$do   = isset( $_POST['do'] ) ? sanitize_key( wp_unslash( $_POST['do'] ) ) : '';
	$user = wp_get_current_user()->user_login;

	if ( 'remove' === $do ) {
		$plugin = plugin_basename( __FILE__ );
		deactivate_plugins( $plugin );
		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/plugin.php';
		$deleted = delete_plugins( array( $plugin ) );
		$query   = true === $deleted ? array( 'agency-bridge' => 'removed' ) : array( 'agency-bridge' => 'deactivated' );
		wp_safe_redirect( add_query_arg( $query, admin_url( 'plugins.php' ) ) );
		exit;
	}

	list( $set, $error ) = agency_bridge_apply_set();
	if ( ! $set ) {
		wp_die( esc_html( 'Набір правок пошкоджений: ' . $error ), 500 );
	}
	if ( 'apply' === $do ) {
		$result = $set->apply( $user );
	} elseif ( 'rollback' === $do ) {
		$result = $set->rollback();
	} else {
		wp_die( esc_html__( 'Невідома дія.', 'agency-bridge-apply' ), 400 );
	}
	set_transient( 'agency_bridge_apply_result_' . get_current_user_id(), $result, 10 * MINUTE_IN_SECONDS );
	wp_safe_redirect( agency_bridge_apply_url( array( 'done' => $do ) ) );
	exit;
}

add_action(
	'admin_notices',
	function () {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- only picks a notice text.
		$flag = isset( $_GET['agency-bridge'] ) ? sanitize_key( wp_unslash( $_GET['agency-bridge'] ) ) : '';
		if ( 'deactivated' === $flag ) {
			echo '<div class="notice notice-warning"><p>' . esc_html( 'Плагін «Агенція: правки» вимкнено. Видаліть його тут, у списку плагінів.' ) . '</p></div>';
		} elseif ( 'removed' === $flag ) {
			echo '<div class="notice notice-success"><p>' . esc_html( 'Плагін «Агенція: правки» видалено.' ) . '</p></div>';
		}
	}
);

const AGENCY_BRIDGE_APPLY_TYPES = array(
	'option'     => 'Налаштування',
	'post_field' => 'Запис / сторінка',
	'post_meta'  => 'Поле запису',
	'term_field' => 'Категорія / термін',
	'term_meta'  => 'Поле терміна',
	'elementor'  => 'Elementor',
	'theme_file' => 'Файл теми',
);

const AGENCY_BRIDGE_APPLY_STATES = array(
	'ready'    => array( 'Готово до застосування', '#2271b1' ),
	'done'     => array( 'Вже є на сайті', '#008a20' ),
	'conflict' => array( 'Конфлікт', '#d63638' ),
	'invalid'  => array( 'Помилка', '#d63638' ),
);

function agency_bridge_apply_page() {
	if ( ! agency_bridge_apply_allowed() ) {
		wp_die( esc_html__( 'Недостатньо прав.', 'agency-bridge-apply' ), 403 );
	}
	list( $set, $error ) = agency_bridge_apply_set();
	echo '<div class="wrap"><h1>' . esc_html( 'Агенція: правки' ) . '</h1>';
	if ( ! $set ) {
		echo '<div class="notice notice-error"><p>' . esc_html( 'Набір правок пошкоджений: ' . $error ) . '</p></div></div>';
		return;
	}

	$result = get_transient( 'agency_bridge_apply_result_' . get_current_user_id() );
	if ( $result ) {
		delete_transient( 'agency_bridge_apply_result_' . get_current_user_id() );
		$class = ! empty( $result['ok'] ) ? 'notice-success' : 'notice-error';
		echo '<div class="notice ' . esc_attr( $class ) . '"><p>' . esc_html( (string) $result['message'] ) . '</p>';
		foreach ( (array) ( $result['conflicts'] ?? array() ) as $c ) {
			echo '<p>' . esc_html( '№' . $c['n'] . ' ' . $c['label'] . ': ' . $c['message'] . ' (зараз: ' . $c['current'] . ')' ) . '</p>';
		}
		echo '</div>';
	}

	$check    = $set->check();
	$manifest = $set->manifest();
	$labels   = array(
		'ready'    => 'Можна застосувати.',
		'applied'  => 'Правки застосовані. Якщо щось не так, натисніть «Відкотити».',
		'done'     => 'Усі ці правки вже є на сайті.',
		'conflict' => 'Є конфлікти: частину значень на сайті змінили після того, як ми зробили копію. Нічого не буде змінено, поки агенція не оновить набір правок.',
		'invalid'  => 'Є помилки в наборі правок або на сайті немає потрібних записів. Нічого не буде змінено.',
	);
	echo '<p><strong>' . esc_html( 'Замовлення: ' . ( $manifest['order'] ?? '' ) ) . '</strong> · '
		. esc_html( 'правок: ' . count( $manifest['edits'] ) ) . ' · '
		. esc_html( 'підготовлено: ' . ( $manifest['created_at'] ?? '' ) ) . '</p>';
	echo '<p>' . esc_html( $labels[ $check['status'] ] ?? $check['status'] ) . '</p>';
	if ( ! empty( $manifest['note'] ) ) {
		echo '<p>' . esc_html( (string) $manifest['note'] ) . '</p>';
	}

	echo '<table class="widefat striped" style="max-width:1100px"><thead><tr><th>№</th><th>' . esc_html( 'Що' ) . '</th><th>' . esc_html( 'Де' ) . '</th><th>' . esc_html( 'Стан' ) . '</th><th>' . esc_html( 'Деталі' ) . '</th></tr></thead><tbody>';
	foreach ( $check['items'] as $item ) {
		$state = AGENCY_BRIDGE_APPLY_STATES[ $item['state'] ] ?? array( $item['state'], '#50575e' );
		$extra = $item['message'] ?? '';
		if ( isset( $item['current'] ) ) {
			$extra .= ' Очікували: «' . $item['expected'] . '», на сайті: «' . $item['current'] . '».';
		}
		echo '<tr><td>' . esc_html( (string) $item['n'] ) . '</td><td>' . esc_html( AGENCY_BRIDGE_APPLY_TYPES[ $item['type'] ] ?? $item['type'] ) . '</td>'
			. '<td>' . esc_html( $item['label'] ) . '</td><td style="color:' . esc_attr( $state[1] ) . ';font-weight:600">' . esc_html( $state[0] ) . '</td>'
			. '<td>' . esc_html( $extra ) . '</td></tr>';
	}
	echo '</tbody></table>';

	$button = function ( $do, $text, $primary, $enabled, $confirm = '' ) {
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="display:inline-block;margin:16px 8px 0 0">';
		wp_nonce_field( 'agency_bridge_apply' );
		echo '<input type="hidden" name="action" value="agency_bridge_apply"><input type="hidden" name="do" value="' . esc_attr( $do ) . '">';
		$attrs = $enabled ? '' : ' disabled';
		if ( $confirm ) {
			$attrs .= ' onclick="return confirm(' . esc_attr( wp_json_encode( $confirm ) ) . ')"';
		}
		echo '<button type="submit" class="button' . ( $primary ? ' button-primary' : '' ) . '"' . $attrs . '>' . esc_html( $text ) . '</button></form>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- $attrs is built above from fixed strings and esc_attr.
	};
	$saved = $check['saved'];
	$button( 'apply', 'Застосувати правки', true, 'ready' === $check['status'] );
	$button( 'rollback', 'Відкотити', false, 'applied' === $saved, 'Повернути все, як було до правок?' );
	$button( 'remove', 'Видалити плагін', false, true, 'Видалити плагін «Агенція: правки»? Резервні копії лишаться на сайті в закритій папці, і відкотити можна буде, якщо завантажити цей самий плагін знову.' );
	echo '<p style="color:#50575e">' . esc_html( 'Перед записом плагін зберігає резервну копію кожного зміненого значення і файлу. «Відкотити» повертає їх, якщо після правок ці місця ніхто не змінював.' ) . '</p>';
	echo '</div>';
}
