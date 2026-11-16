<?php

namespace Tests\Feature\Api\V1;

use App\Models\User;
use App\Support\InitialSetup;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class SetupTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->withHeader('Referer', config('app.url'));
        InitialSetup::forget();
    }

    protected function tearDown(): void
    {
        InitialSetup::forget();

        parent::tearDown();
    }

    /**
     * @param  array<string, mixed>  $overrides
     * @return array<string, mixed>
     */
    private function input(array $overrides = []): array
    {
        return [
            'code' => InitialSetup::code(),
            'name' => 'Admin',
            'email' => 'admin@example.com',
            'password' => 'una-password-lunga',
            'password_confirmation' => 'una-password-lunga',
            ...$overrides,
        ];
    }

    public function test_status_reports_whether_setup_is_required(): void
    {
        $this->getJson(route('api.v1.setup.show'))->assertOk()->assertJsonPath('data.required', true);

        User::factory()->admin()->create();

        $this->getJson(route('api.v1.setup.show'))->assertOk()->assertJsonPath('data.required', false);
    }

    public function test_first_admin_is_created_and_logged_in_with_the_code(): void
    {
        $this->postJson(route('api.v1.setup.store'), $this->input())
            ->assertCreated()
            ->assertJsonPath('data.isAdmin', true)
            ->assertJsonPath('data.isApproved', true);

        $user = User::firstWhere('email', 'admin@example.com');
        $this->assertAuthenticatedAs($user);
        $this->assertTrue($user->is_admin);
        $this->assertFalse(InitialSetup::required());
    }

    public function test_wrong_code_is_rejected(): void
    {
        InitialSetup::code();

        $this->postJson(route('api.v1.setup.store'), $this->input(['code' => 'SBAGLIATO']))
            ->assertUnprocessable()
            ->assertJsonValidationErrors('code');

        $this->assertDatabaseCount('users', 0);
    }

    public function test_setup_is_closed_once_an_admin_exists(): void
    {
        User::factory()->admin()->create();

        $this->postJson(route('api.v1.setup.store'), $this->input())->assertConflict();

        $this->assertDatabaseMissing('users', ['email' => 'admin@example.com']);
    }

    public function test_code_is_single_use(): void
    {
        $input = $this->input();
        $this->postJson(route('api.v1.setup.store'), $input)->assertCreated();
        $this->postJson(route('api.v1.auth.logout'));

        $this->postJson(route('api.v1.setup.store'), [...$input, 'email' => 'altro@example.com'])->assertConflict();
    }

    public function test_registration_waits_for_the_setup(): void
    {
        $this->postJson(route('api.v1.auth.register'), [
            'name' => 'Nuovo',
            'email' => 'nuovo@example.com',
            'password' => 'una-password-lunga',
            'password_confirmation' => 'una-password-lunga',
        ])->assertConflict();
    }

    public function test_setup_code_command_prints_the_page_or_reports_completion(): void
    {
        $this->artisan('setup:code', ['--url' => true])
            ->expectsOutputToContain('/setup?code=')
            ->assertSuccessful();

        User::factory()->admin()->create();

        $this->artisan('setup:code')
            ->expectsOutputToContain('già completata')
            ->assertSuccessful();
    }
}
