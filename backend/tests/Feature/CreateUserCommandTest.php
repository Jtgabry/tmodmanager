<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class CreateUserCommandTest extends TestCase
{
    use RefreshDatabase;

    public function test_it_creates_an_approved_admin(): void
    {
        $this->artisan('user:create', ['--admin' => true])
            ->expectsQuestion('Nome', 'Utente')
            ->expectsQuestion('Email', 'utente@example.com')
            ->expectsQuestion('Password', 'password-sicura')
            ->assertSuccessful();

        $user = User::firstWhere('email', 'utente@example.com');
        $this->assertTrue($user->is_admin);
        $this->assertTrue($user->isApproved());
    }

    public function test_it_creates_a_regular_user_without_the_flag(): void
    {
        $this->artisan('user:create')
            ->expectsQuestion('Nome', 'Amico')
            ->expectsQuestion('Email', 'amico@example.com')
            ->expectsQuestion('Password', 'password-sicura')
            ->assertSuccessful();

        $this->assertFalse(User::firstWhere('email', 'amico@example.com')->is_admin);
    }
}
