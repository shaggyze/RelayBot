<?php
// A secure script to receive a database backup with a dynamic filename.

header('Content-Type: application/json'); // We will always respond with JSON.

// --- CONFIGURATION ---
$secret_key = 'UPLOAD_SECRET_KEY';
$upload_dir = __DIR__ . '/RelayBot/backups/'; 
// The base URL of your backup directory, so we can construct a download link.
// IMPORTANT: Make sure this is correct for your server setup!
$base_url = 'https://' . $_SERVER['HTTP_HOST'] . '/RelayBot/backups/';

// --- HELPER FUNCTION to send a JSON error response ---
function send_error($message, $code = 400) {
    http_response_code($code);
    echo json_encode(['success' => false, 'message' => $message]);
    exit();
}

// --- SECURITY CHECKS ---
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    send_error('This endpoint only accepts POST requests.', 405);
}

$auth_header = $_SERVER['HTTP_X_UPLOAD_SECRET'] ?? '';
if (!hash_equals($secret_key, $auth_header)) {
    send_error('Invalid or missing secret key.', 403);
}

// --- FILE & FILENAME PROCESSING ---
if (!isset($_FILES['file']) || !is_uploaded_file($_FILES['file']['tmp_name'])) {
    send_error('No file was uploaded in the "file" field.');
}
if ($_FILES['file']['error'] !== UPLOAD_ERR_OK) {
    send_error('An error occurred during the file upload process. Code: ' . $_FILES['file']['error'], 500);
}

// [THE FIX] Get the filename from the POST request.
$destination_filename = $_POST['filename'] ?? null;

// Validate the filename to prevent security issues like directory traversal.
if (!$destination_filename || !preg_match('/^database_[0-9]+_[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}\.db$/', $destination_filename)) {
    send_error('Invalid or missing filename format.');
}

// Ensure the backup directory exists and is writable.
if (!is_dir($upload_dir)) {
    if (!mkdir($upload_dir, 0755, true)) {
        send_error('Could not create the backup directory on the server.', 500);
    }
}
if (!is_writable($upload_dir)) {
    send_error('The backup directory is not writable. Please check server permissions.', 500);
}

// Move the uploaded file to its final destination.
$destination_path = $upload_dir . $destination_filename;
if (move_uploaded_file($_FILES['file']['tmp_name'], $destination_path)) {
    // [THE FIX] Respond with a success JSON object including the direct URL.
    $download_url = $base_url . $destination_filename;
    http_response_code(200);
    echo json_encode([
        'success' => true,
        'message' => 'File uploaded successfully.',
        'filename' => $destination_filename,
        'url' => $download_url
    ]);
} else {
    send_error('Failed to move the uploaded file to its final destination.', 500);
}

?>