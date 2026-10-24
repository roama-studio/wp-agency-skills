<?php
/**
 * qa-kit helper. Lives ONLY in the throwaway WordPress Playground
 * that `qa-kit wp` starts; never install it on a real site. Answers
 * ?qa_kit=<action>&token=<QA_KIT_TOKEN> with JSON:
 *   info   - pages, post types, taxonomies, menus, SCF fields and options pages
 *   lint   - PHP syntax of every theme file (token_get_all with TOKEN_PARSE)
 *   stress - the client's worst case: every filled SCF text/textarea at its
 *            limit (x3 without one), +3 long menu items in every menu
 */
defined( 'ABSPATH' ) || exit;

add_action( 'wp_loaded', function () {
	if ( ! isset( $_GET['qa_kit'], $_GET['token'] ) || ! defined( 'QA_KIT_TOKEN' ) ) {
		return;
	}
	if ( ! hash_equals( (string) QA_KIT_TOKEN, (string) $_GET['token'] ) ) {
		return;
	}
	$action = (string) $_GET['qa_kit'];
	$result = array( 'error' => 'unknown action' );
	if ( 'info' === $action ) {
		$result = qa_kit_info();
	} elseif ( 'lint' === $action ) {
		$result = qa_kit_lint();
	} elseif ( 'stress' === $action ) {
		$result = qa_kit_stress();
	}
	header( 'Content-Type: application/json; charset=utf-8' );
	echo wp_json_encode( $result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES );
	exit;
}, 99 );

function qa_kit_path( $url ) {
	$parts = wp_parse_url( $url );
	return ( $parts['path'] ?? '/' ) . ( isset( $parts['query'] ) ? '?' . $parts['query'] : '' );
}

function qa_kit_fields() {
	if ( ! function_exists( 'acf_get_field_groups' ) ) {
		return array();
	}
	$out  = array();
	$walk = function ( $fields, $group ) use ( &$walk, &$out ) {
		foreach ( (array) $fields as $f ) {
			$out[] = array(
				'group'     => $group,
				'name'      => $f['name'],
				'label'     => $f['label'],
				'type'      => $f['type'],
				'maxlength' => isset( $f['maxlength'] ) ? $f['maxlength'] : '',
			);
			if ( ! empty( $f['sub_fields'] ) ) {
				$walk( $f['sub_fields'], $group );
			}
			foreach ( (array) ( $f['layouts'] ?? array() ) as $layout ) {
				$walk( $layout['sub_fields'] ?? array(), $group );
			}
		}
	};
	foreach ( acf_get_field_groups() as $g ) {
		$walk( acf_get_fields( $g ), $g['title'] );
	}
	return $out;
}

function qa_kit_info() {
	$pages = array();
	foreach ( get_posts( array( 'post_type' => 'page', 'post_status' => 'publish', 'numberposts' => -1 ) ) as $p ) {
		$pages[] = array(
			'id'       => $p->ID,
			'title'    => $p->post_title,
			'path'     => qa_kit_path( get_permalink( $p ) ),
			'template' => get_page_template_slug( $p ),
		);
	}
	$types = array();
	foreach ( get_post_types( array( '_builtin' => false, 'show_ui' => true ), 'objects' ) as $t ) {
		if ( 0 === strpos( $t->name, 'wp_' ) || in_array( $t->name, array( 'acf-field-group', 'acf-field', 'acf-post-type', 'acf-taxonomy', 'acf-ui-options-page', 'wpcf7_contact_form' ), true ) ) {
			continue;
		}
		$one     = get_posts( array( 'post_type' => $t->name, 'post_status' => 'publish', 'numberposts' => 1 ) );
		$types[] = array(
			'name'    => $t->name,
			'public'  => (bool) $t->public,
			'archive' => $t->has_archive ? qa_kit_path( get_post_type_archive_link( $t->name ) ) : null,
			'single'  => ( $one && $t->public ) ? qa_kit_path( get_permalink( $one[0] ) ) : null,
		);
	}
	$taxes = array();
	foreach ( get_taxonomies( array( '_builtin' => false, 'show_ui' => true ), 'objects' ) as $tax ) {
		$taxes[] = array( 'name' => $tax->name, 'types' => array_values( (array) $tax->object_type ) );
	}
	$options = array();
	if ( function_exists( 'acf_get_options_pages' ) ) {
		foreach ( (array) acf_get_options_pages() as $op ) {
			$options[] = $op['menu_slug'];
		}
	}
	return array(
		'front_page'   => (int) get_option( 'page_on_front' ),
		'pages'        => $pages,
		'post_types'   => $types,
		'taxonomies'   => $taxes,
		'menus'        => get_nav_menu_locations(),
		'options'      => $options,
		'fields'       => qa_kit_fields(),
		'site_icon'    => (int) get_option( 'site_icon' ),
		'plugins'      => array_values( (array) get_option( 'active_plugins' ) ),
		'wp'           => get_bloginfo( 'version' ),
		'php'          => PHP_VERSION,
	);
}

function qa_kit_lint() {
	$root   = get_stylesheet_directory();
	$errors = array();
	$files  = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $root, FilesystemIterator::SKIP_DOTS ) );
	$count  = 0;
	foreach ( $files as $file ) {
		if ( 'php' !== strtolower( $file->getExtension() ) ) {
			continue;
		}
		$count++;
		try {
			token_get_all( file_get_contents( $file->getPathname() ), TOKEN_PARSE );
		} catch ( Throwable $e ) {
			$errors[] = array(
				'file'    => ltrim( str_replace( '\\', '/', substr( $file->getPathname(), strlen( $root ) ) ), '/' ),
				'line'    => $e->getLine(),
				'message' => $e->getMessage(),
			);
		}
	}
	return array( 'files' => $count, 'errors' => $errors );
}

// The longest value a client can save: the field's limit, or the text x3 without one.
function qa_kit_long( $value, $field ) {
	$max = isset( $field['maxlength'] ) ? (int) $field['maxlength'] : 0;
	if ( $max <= 0 ) {
		return trim( str_repeat( $value . ' ', 3 ) );
	}
	// Plain text: cutting markup (a <br> in a title) at the limit would print half a tag.
	$value = trim( preg_replace( '/\s+/u', ' ', wp_strip_all_tags( $value ) ) );
	if ( '' === $value ) {
		return $value;
	}
	$s = $value;
	while ( mb_strlen( $s ) < $max ) {
		$s .= ' ' . $value;
	}
	return mb_substr( $s, 0, $max );
}

function qa_kit_stress() {
	global $wpdb;
	$changed = array( 'post_meta' => 0, 'options' => 0, 'menu_items' => 0 );
	if ( function_exists( 'acf_get_field' ) ) {
		$rows = $wpdb->get_results( "SELECT post_id, meta_key, meta_value FROM {$wpdb->postmeta} WHERE meta_key LIKE '\\_%' AND meta_value LIKE 'field\\_%'" );
		foreach ( $rows as $row ) {
			$field = acf_get_field( $row->meta_value );
			if ( ! $field || ! in_array( $field['type'], array( 'text', 'textarea' ), true ) ) {
				continue;
			}
			$name  = substr( $row->meta_key, 1 );
			$value = get_post_meta( $row->post_id, $name, true );
			if ( ! is_string( $value ) || '' === trim( $value ) ) {
				continue;
			}
			update_post_meta( $row->post_id, $name, qa_kit_long( $value, $field ) );
			$changed['post_meta']++;
		}
		$opts = $wpdb->get_results( "SELECT option_name, option_value FROM {$wpdb->options} WHERE option_name LIKE '\\_options\\_%' AND option_value LIKE 'field\\_%'" );
		foreach ( $opts as $row ) {
			$field = acf_get_field( $row->option_value );
			if ( ! $field || ! in_array( $field['type'], array( 'text', 'textarea' ), true ) ) {
				continue;
			}
			$name  = substr( $row->option_name, 1 );
			$value = get_option( $name );
			if ( ! is_string( $value ) || '' === trim( $value ) ) {
				continue;
			}
			update_option( $name, qa_kit_long( $value, $field ) );
			$changed['options']++;
		}
	}
	foreach ( array_unique( array_values( get_nav_menu_locations() ) ) as $menu_id ) {
		if ( ! $menu_id ) {
			continue;
		}
		foreach ( array( 'Дуже довгий пункт меню', 'Ще один пункт', 'Третій новий пункт меню' ) as $i => $label ) {
			wp_update_nav_menu_item( $menu_id, 0, array(
				'menu-item-title'  => $label,
				'menu-item-url'    => home_url( '/#qa-kit-' . $i ),
				'menu-item-status' => 'publish',
				'menu-item-type'   => 'custom',
			) );
			$changed['menu_items']++;
		}
	}
	return $changed;
}
