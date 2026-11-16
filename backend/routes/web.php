<?php

use Illuminate\Support\Facades\Route;

// Il frontend è una SPA React separata (cartella /frontend): qui niente viste Blade.
Route::get('/', fn () => response()->json(['app' => config('app.name'), 'api' => url('/api')]));
