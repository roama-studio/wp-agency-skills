<?php
/**
 * qa-kit wp-site import: runs the statements of a client's MySQL dump
 * (split and filtered by lib/wpsite.mjs into a JSON array) through $wpdb, which in
 * Playground is the SQLite translator. Every table already there (the fresh install)
 * is dropped first, so a dump without DROP TABLE still imports. Prints one JSON line.
 *
 * Usage (inside Playground): php wp-site-import.php /qa-import/statements.json
 */

define( 'SHORTINIT', true );
require '/wordpress/wp-load.php';

global $wpdb;
$wpdb->suppress_errors( true );
$statements = json_decode( (string) file_get_contents( $argv[1] ), true );
if ( ! is_array( $statements ) ) {
	echo json_encode( array( 'error' => 'the statements file is not a JSON array' ) ), "\n";
	exit( 1 );
}

$dropped = 0;
foreach ( (array) $wpdb->get_col( 'SHOW TABLES' ) as $table ) {
	if ( false !== $wpdb->query( 'DROP TABLE IF EXISTS `' . str_replace( '`', '', $table ) . '`' ) ) {
		$dropped++;
	}
}

$ran    = 0;
$errors = array();
foreach ( $statements as $sql ) {
	if ( false === $wpdb->query( $sql ) ) {
		$errors[] = array(
			'sql'   => substr( $sql, 0, 160 ),
			'error' => substr( (string) $wpdb->last_error, 0, 300 ),
		);
		continue;
	}
	$ran++;
}

echo json_encode(
	array(
		'dropped' => $dropped,
		'ran'     => $ran,
		'failed'  => count( $errors ),
		'errors'  => array_slice( $errors, 0, 20 ),
		'tables'  => count( (array) $wpdb->get_col( 'SHOW TABLES' ) ),
	)
), "\n";
