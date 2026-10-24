<?php
/**
 * both plugins' engines on the oldest PHP we support (7.4), in a fresh
 * Playground WordPress (no plugins). Run through e2e.mjs php74. Prints one JSON line.
 *
 * @package AgencyBridge
 */

define( 'WP_DISABLE_FATAL_ERROR_HANDLER', true );
register_shutdown_function(
	function () {
		$e = error_get_last();
		if ( $e && in_array( $e['type'], array( E_ERROR, E_PARSE, E_COMPILE_ERROR, E_CORE_ERROR ), true ) ) {
			echo json_encode( array( 'fatal' => $e ) ), "
";
		}
	}
);
require '/wordpress/wp-load.php';
require '/qa-bridge/apply/includes/class-agency-bridge-edits.php';
require '/qa-bridge/export/includes/class-agency-bridge-export.php';

$out   = array( 'php' => PHP_VERSION, 'zip' => class_exists( 'ZipArchive' ) );
$theme = get_stylesheet();
$file  = 'bridge-smoke.css';
$body  = "/* smoke */\n";
$set   = array(
	'manifest' => array(
		'format' => 'agency-edits/1',
		'id'     => str_repeat( 'c', 32 ),
		'order'  => 'php74',
		'theme'  => $theme,
		'site'   => array( 'home' => home_url(), 'aliases' => array() ),
		'edits'  => array(
			array( 'type' => 'option', 'name' => 'blogdescription', 'before' => get_option( 'blogdescription' ), 'after' => 'PHP 7.4 smoke' ),
			array( 'type' => 'post_field', 'post' => 1, 'field' => 'post_title', 'before' => get_post( 1 )->post_title, 'after' => 'Smoke title' ),
			array( 'type' => 'theme_file', 'path' => 'smoke/' . $file, 'before_sha256' => null, 'after_sha256' => hash( 'sha256', $body ) ),
		),
	),
	'files'    => array( 'smoke/' . $file => base64_encode( $body ) ),
);
$edits = new Agency_Bridge_Edits( $set );
$out['check']    = $edits->check()['status'];
$out['apply']    = $edits->apply( 'smoke' )['status'];
$out['applied']  = get_option( 'blogdescription' ) === 'PHP 7.4 smoke' && 'Smoke title' === get_post( 1 )->post_title && is_file( get_stylesheet_directory() . '/smoke/' . $file );
$out['rollback'] = $edits->rollback()['status'];
$out['restored'] = get_option( 'blogdescription' ) !== 'PHP 7.4 smoke' && ! is_dir( get_stylesheet_directory() . '/smoke' );

add_filter( 'agency_bridge_export_budget', function () { return 0.01; } );
add_filter( 'agency_bridge_export_batch', function () { return 300; } );
$p     = Agency_Bridge_Export::start();
$steps = 0;
while ( 'done' !== $p['phase'] && $steps < 400 ) {
	$p = Agency_Bridge_Export::step();
	$steps++;
}
$job                  = Agency_Bridge_Export::job();
$out['export']        = $p['phase'];
$out['export_steps']  = $steps;
$out['export_bytes']  = $job ? (int) $job['bytes'] : 0;
$zip                  = new ZipArchive();
$out['export_has_db'] = $job && true === $zip->open( $job['zip'] ) && false !== $zip->locateName( 'database.sql' ) && false !== $zip->locateName( 'files/wp-includes/version.php' ) && false === $zip->locateName( 'files/wp-config.php' );
Agency_Bridge_Export::cleanup();
$out['export_cleaned'] = ! $job || ! is_dir( $job['dir'] );

// The same export through PclZip (hosts without the zip extension), in bigger batches.
add_filter( 'agency_bridge_export_zipper', function () { return 'PclZip'; } );
add_filter( 'agency_bridge_export_batch', function () { return 1500; }, 20 );
$p     = Agency_Bridge_Export::start();
$steps = 0;
while ( 'done' !== $p['phase'] && $steps < 400 ) {
	$p = Agency_Bridge_Export::step();
	$steps++;
}
$job                 = Agency_Bridge_Export::job();
$zip                 = new ZipArchive();
$out['pclzip']       = $p['phase'];
$out['pclzip_steps'] = $steps;
$out['pclzip_ok']    = $job && true === $zip->open( $job['zip'] ) && false !== $zip->locateName( 'database.sql' ) && false !== $zip->locateName( 'files/wp-includes/version.php' )
	&& $zip->numFiles === $job['files'] + 2;
Agency_Bridge_Export::cleanup();
echo json_encode( $out ), "\n";
