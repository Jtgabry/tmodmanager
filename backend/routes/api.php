<?php

use App\Http\Controllers\Api\V1\Admin\InstallationController;
use App\Http\Controllers\Api\V1\Admin\InvitationController;
use App\Http\Controllers\Api\V1\Admin\ServerController as AdminServerController;
use App\Http\Controllers\Api\V1\Admin\UserController;
use App\Http\Controllers\Api\V1\Admin\UserServerAccessController;
use App\Http\Controllers\Api\V1\Auth\CurrentUserController;
use App\Http\Controllers\Api\V1\Auth\RegistrationController;
use App\Http\Controllers\Api\V1\Auth\SessionController;
use App\Http\Controllers\Api\V1\Auth\SetupController;
use App\Http\Controllers\Api\V1\ServerBackupController;
use App\Http\Controllers\Api\V1\ServerConsoleController;
use App\Http\Controllers\Api\V1\ServerConsoleTicketController;
use App\Http\Controllers\Api\V1\ServerController;
use App\Http\Controllers\Api\V1\ServerFileContentController;
use App\Http\Controllers\Api\V1\ServerFileController;
use App\Http\Controllers\Api\V1\ServerModArchiveController;
use App\Http\Controllers\Api\V1\ServerModController;
use App\Http\Controllers\Api\V1\ServerModpackActivationController;
use App\Http\Controllers\Api\V1\ServerModpackController;
use App\Http\Controllers\Api\V1\ServerModpackImportController;
use App\Http\Controllers\Api\V1\ServerModWorkshopController;
use App\Http\Controllers\Api\V1\ServerPowerController;
use App\Http\Controllers\Api\V1\ServerTrashController;
use App\Services\Agent\ServerPowerAction;
use Illuminate\Support\Facades\Route;

Route::get('/health', fn () => ['status' => 'ok', 'app' => config('app.name')]);

Route::prefix('v1')
    ->name('api.v1.')
    ->where([
        'server' => '[a-z0-9][a-z0-9-]{0,31}',
        'mod' => '[A-Za-z0-9_]{1,64}',
        'modpack' => '[a-z0-9]{8}',
        'item' => '[0-9]{13}-[0-9a-f]{8}',
        'installation' => '[0-9a-f]{8}',
        'version' => '[0-9]{1,9}(\.[0-9]{1,9}){0,3}',
        'backup' => '[A-Za-z_-]{1,64}_backup_[0-9]{14}\.zip',
    ])
    ->group(function () {
        Route::middleware('throttle:10,1')->group(function () {
            Route::post('/auth/login', [SessionController::class, 'store'])->name('auth.login');
            Route::post('/auth/register', [RegistrationController::class, 'store'])->name('auth.register');
            Route::post('/setup', [SetupController::class, 'store'])->name('setup.store');
        });

        Route::get('/setup', [SetupController::class, 'show'])->name('setup.show');

        Route::post('/auth/logout', [SessionController::class, 'destroy'])->middleware('auth:sanctum')->name('auth.logout');

        Route::middleware(['auth:sanctum', 'approved'])->group(function () {
            Route::get('/auth/user', CurrentUserController::class)->name('auth.user');

            Route::get('/servers', [ServerController::class, 'index'])->name('servers.index');
            Route::get('/servers/{server}', [ServerController::class, 'show'])->name('servers.show');
            Route::post('/servers/{server}/{action}', ServerPowerController::class)
                ->whereIn('action', array_column(ServerPowerAction::cases(), 'value'))
                ->name('servers.power');
            Route::get('/servers/{server}/console', [ServerConsoleController::class, 'show'])->name('servers.console.show');
            Route::post('/servers/{server}/console', [ServerConsoleController::class, 'store'])->name('servers.console.store');
            Route::post('/servers/{server}/console/ticket', ServerConsoleTicketController::class)->name('servers.console.ticket');

            Route::controller(ServerModWorkshopController::class)->prefix('/servers/{server}')->name('servers.mods.workshop.')->group(function () {
                Route::get('/mods/updates', 'index')->name('index');
                Route::post('/mods/updates', 'store')->name('store');
                Route::get('/mods/updates/job', 'job')->name('job');
                Route::delete('/mods/updates/job/{mod}', 'cancel')->name('cancel');
                Route::get('/workshop/search', 'search')->name('search');
                Route::get('/workshop/browse', 'browse')->name('browse');
                Route::get('/workshop/items/{workshopItem}', 'item')->whereNumber('workshopItem')->name('item');
                Route::post('/workshop/install', 'install')->name('install');
                Route::post('/workshop/install-names', 'installNames')->name('install-names');
                Route::get('/workshop/pending', 'pending')->name('pending');
                Route::post('/workshop/pending/apply', 'applyPending')->name('pending.apply');
                Route::delete('/workshop/pending/{mod}', 'dismissPending')->name('pending.dismiss');
                Route::put('/mods/{mod}/workshop', 'link')->name('link');
                Route::delete('/mods/{mod}/workshop', 'unlink')->name('unlink');
            });

            Route::get('/servers/{server}/mods', [ServerModController::class, 'index'])->name('servers.mods.index');
            Route::post('/servers/{server}/mods', [ServerModController::class, 'store'])->name('servers.mods.store');
            Route::patch('/servers/{server}/mods/{mod}', [ServerModController::class, 'update'])->name('servers.mods.update');
            Route::delete('/servers/{server}/mods/{mod}', [ServerModController::class, 'destroy'])->name('servers.mods.destroy');
            Route::get('/servers/{server}/mods/{mod}/download', [ServerModController::class, 'download'])->name('servers.mods.download');
            Route::get('/servers/{server}/mods/{mod}/icon', [ServerModController::class, 'icon'])->name('servers.mods.icon');

            Route::controller(ServerModArchiveController::class)->prefix('/servers/{server}/archive')->name('servers.archive.')->group(function () {
                Route::get('/', 'index')->name('index');
                Route::post('/', 'store')->name('store');
                Route::delete('/{mod}/{version}', 'destroy')->name('destroy');
                Route::post('/{mod}/{version}/use', 'use')->name('use');
            });

            Route::get('/servers/{server}/modpacks/importable', [ServerModpackImportController::class, 'index'])->name('servers.modpacks.importable');
            Route::post('/servers/{server}/modpacks/import', [ServerModpackImportController::class, 'store'])->name('servers.modpacks.import');
            Route::get('/servers/{server}/modpacks', [ServerModpackController::class, 'index'])->name('servers.modpacks.index');
            Route::post('/servers/{server}/modpacks', [ServerModpackController::class, 'store'])->name('servers.modpacks.store');
            Route::put('/servers/{server}/modpacks/{modpack}', [ServerModpackController::class, 'update'])->name('servers.modpacks.update');
            Route::delete('/servers/{server}/modpacks/{modpack}', [ServerModpackController::class, 'destroy'])->name('servers.modpacks.destroy');
            Route::post('/servers/{server}/modpacks/{modpack}/activation', [ServerModpackActivationController::class, 'store'])->name('servers.modpacks.activate');
            Route::delete('/servers/{server}/modpacks/{modpack}/activation', [ServerModpackActivationController::class, 'destroy'])->name('servers.modpacks.deactivate');

            Route::controller(ServerFileController::class)->prefix('/servers/{server}/files')->name('servers.files.')->group(function () {
                Route::get('/roots', 'roots')->name('roots');
                Route::get('/', 'index')->name('index');
                Route::get('/download', 'download')->name('download');
                Route::post('/upload', 'upload')->name('upload');
                Route::post('/directories', 'makeDirectory')->name('directories.store');
                Route::post('/rename', 'rename')->name('rename');
                Route::delete('/', 'destroy')->name('destroy');
            });
            Route::get('/servers/{server}/files/content', [ServerFileContentController::class, 'show'])->name('servers.files.content.show');
            Route::put('/servers/{server}/files/content', [ServerFileContentController::class, 'update'])->name('servers.files.content.update');

            Route::controller(ServerBackupController::class)->prefix('/servers/{server}/backups')->name('servers.backups.')->group(function () {
                Route::get('/', 'index')->name('index');
                Route::post('/', 'store')->name('store');
                Route::get('/{backup}/download', 'download')->name('download');
                Route::delete('/{backup}', 'destroy')->name('destroy');
            });

            Route::controller(ServerTrashController::class)->prefix('/servers/{server}/trash')->name('servers.trash.')->group(function () {
                Route::get('/', 'index')->name('index');
                Route::post('/{item}/restore', 'restore')->name('restore');
                Route::delete('/{item}', 'destroy')->name('destroy');
                Route::delete('/', 'clear')->name('clear');
            });

            Route::prefix('admin')->name('admin.')->middleware('can:admin')->group(function () {
                Route::apiResource('users', UserController::class)->only(['index', 'update', 'destroy']);
                Route::put('/users/{user}/servers/{server}', [UserServerAccessController::class, 'update'])->name('users.servers.update');
                Route::delete('/users/{user}/servers/{server}', [UserServerAccessController::class, 'destroy'])->name('users.servers.destroy');
                Route::apiResource('invitations', InvitationController::class)->only(['index', 'store', 'destroy']);

                Route::get('/servers/defaults', [AdminServerController::class, 'defaults'])->name('servers.defaults');
                Route::apiResource('servers', AdminServerController::class)->only(['store', 'show', 'update', 'destroy']);
                Route::post('/servers/{server}/world/recreate', [AdminServerController::class, 'recreateWorld'])->name('servers.world.recreate');

                Route::get('/installations', [InstallationController::class, 'index'])->name('installations.index');
                Route::get('/releases/{game}', [InstallationController::class, 'releases'])->whereIn('game', ['terraria', 'tmodloader'])->name('releases');
                Route::post('/installations/{installation}/update', [InstallationController::class, 'update'])->name('installations.update');
                Route::post('/installations/terraria/versions', [InstallationController::class, 'storeTerrariaVersion'])->name('installations.terraria.store');
                Route::delete('/installations/{installation}', [InstallationController::class, 'destroy'])->name('installations.destroy');
            });
        });
    });
